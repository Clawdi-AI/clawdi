import { describe, expect, it } from "bun:test";
import {
	hostedManifestMitmProfiles,
	runtimeInstallerMitmProfiles,
} from "../src/runtime/hosted-mitm-profiles";
import { mitmProfileSchema } from "../src/runtime/mitm-profiles";

const providerProfiles = (profiles: ReturnType<typeof hostedManifestMitmProfiles>["profiles"]) =>
	profiles.filter((profile) => profile.owner === "provider-projection");

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
					preservePath: true,
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

	it("requires upstream base URLs for HTTP and websocket rewrite profiles", () => {
		for (const kind of ["http", "websocket"] as const) {
			expect(
				mitmProfileSchema.safeParse({
					id: `missing-upstream-${kind}`,
					enabled: true,
					kind,
					match: { scheme: kind === "websocket" ? "wss" : "https", host: "example.com" },
					rewrite: {
						setHeaders: {
							authorization: "Bearer public-test-token",
						},
					},
				}).success,
			).toBe(false);
		}
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

	it("rejects path prefixes that the native sidecar would reject", () => {
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

	it("derives managed provider rewrite profiles from hosted provider projection", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://ai-gateway.example.test/v1",
					apiMode: "openai_chat",
					managed_by: "clawdi",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(bundle.profiles.map((profile) => profile.id)).toContain("runtime-installer-nodejs-dist");
		expect(providerProfiles(bundle.profiles)).toEqual([
			{
				id: "managed-provider",
				enabled: true,
				kind: "provider",
				match: {
					scheme: "https",
					host: "ai-gateway.example.test",
					headers: {},
					query: {},
				},
				rewrite: {
					preservePath: true,
					setHeaders: {
						authorization: {
							type: "secretRef",
							secretRef: "secret://provider.default.apiKey",
							prefix: "Bearer ",
						},
					},
				},
				logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
				priority: 80,
				owner: "provider-projection",
			},
		]);
	});

	it("adds explicit runtime installer passthrough allowlist profiles", () => {
		const profiles = runtimeInstallerMitmProfiles();
		expect(profiles).toContainEqual(
			expect.objectContaining({
				id: "runtime-installer-openclaw-install",
				kind: "passthrough",
				match: expect.objectContaining({
					scheme: "https",
					host: "openclaw.ai",
					pathPrefix: "/install-cli.sh",
				}),
				owner: "runtime-installer",
			}),
		);
		expect(profiles).toContainEqual(
			expect.objectContaining({
				id: "runtime-installer-nodejs-dist",
				kind: "passthrough",
				match: expect.objectContaining({
					scheme: "https",
					host: "nodejs.org",
					pathPrefix: "/dist/",
				}),
				owner: "runtime-installer",
			}),
		);
		expect(profiles).toContainEqual(
			expect.objectContaining({
				id: "runtime-installer-npm-registry",
				kind: "passthrough",
				match: expect.objectContaining({
					scheme: "https",
					host: "registry.npmjs.org",
					pathPrefix: "/",
				}),
				owner: "runtime-installer",
			}),
		);
		expect(profiles).toContainEqual(
			expect.objectContaining({
				id: "runtime-installer-hermes-install",
				kind: "passthrough",
				match: expect.objectContaining({
					scheme: "https",
					host: "hermes-agent.nousresearch.com",
					pathPrefix: "/install.sh",
				}),
				owner: "runtime-installer",
			}),
		);
		expect(profiles).toContainEqual(
			expect.objectContaining({
				id: "runtime-installer-uv-releases",
				kind: "passthrough",
				match: expect.objectContaining({
					scheme: "https",
					host: "releases.astral.sh",
					pathPrefix: "/installers/uv/",
				}),
				owner: "runtime-installer",
			}),
		);
		expect(profiles).toEqual(
			expect.arrayContaining([
				{
					id: "runtime-installer-pythonhosted",
					enabled: true,
					kind: "passthrough",
					match: {
						scheme: "https",
						host: "files.pythonhosted.org",
						pathPrefix: "/",
						headers: {},
						query: {},
					},
					logging: { redactHeaders: [], redactUrlPatterns: [] },
					priority: 200,
					owner: "runtime-installer",
					description: "Hermes Python package artifacts.",
				},
			]),
		);
	});

	it("builds managed provider profiles for runtime-scoped providers", () => {
		const bundle = hostedManifestMitmProfiles({
			providers: {
				openclaw: {
					baseUrl: "https://openclaw-provider.example.test/v1",
					apiMode: "openai_chat",
					managed_by: "clawdi",
					apiKeySecretRef: "provider.openclaw.apiKey",
				},
				hermes: {
					baseUrl: "https://hermes-provider.example.test/v1",
					apiMode: "openai_responses",
					managed_by: "clawdi",
					apiKeySecretRef: "provider.hermes.apiKey",
				},
			},
		});

		expect(providerProfiles(bundle.profiles).map((profile) => profile.id)).toEqual([
			"managed-provider-hermes",
			"managed-provider-openclaw",
		]);
		expect(providerProfiles(bundle.profiles).map((profile) => profile.match.host)).toEqual([
			"hermes-provider.example.test",
			"openclaw-provider.example.test",
		]);
	});

	it("does not derive provider MITM profiles without a managed provider secret ref", () => {
		const bundle = hostedManifestMitmProfiles({
			controlPlane: { cloudApiUrl: "https://cloud-api.test" },
			providers: {
				default: {
					baseUrl: "https://sub2api.test/v1",
					apiMode: "openai_chat",
					managed_by: "clawdi",
				},
			},
		});

		expect(providerProfiles(bundle.profiles)).toEqual([]);
		expect(bundle.profiles.every((profile) => profile.owner === "runtime-installer")).toBe(true);
	});

	it("does not derive provider MITM profiles for BYOK providers", () => {
		const bundle = hostedManifestMitmProfiles({
			providers: {
				default: {
					baseUrl: "https://byok-provider.example.test/v1",
					apiMode: "openai_chat",
					managed_by: "user",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(providerProfiles(bundle.profiles)).toEqual([]);
		expect(bundle.profiles.every((profile) => profile.owner === "runtime-installer")).toBe(true);
	});

	it("does not derive provider MITM profiles for unsupported provider API modes", () => {
		const bundle = hostedManifestMitmProfiles({
			providers: {
				default: {
					baseUrl: "https://anthropic.example.test/v1",
					apiMode: "anthropic_messages",
					managed_by: "clawdi",
					apiKeySecretRef: "provider.default.apiKey",
				},
			},
		});

		expect(providerProfiles(bundle.profiles)).toEqual([]);
		expect(bundle.profiles.every((profile) => profile.owner === "runtime-installer")).toBe(true);
	});
});
