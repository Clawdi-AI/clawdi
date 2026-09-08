import { describe, expect, test } from "bun:test";
import {
	type AiProvider,
	type AiProviderCatalog,
	NATIVE_AI_PROVIDERS,
	nativeAiProvider,
	nativeAiProviderForRuntime,
	nativeAiProviderRuntime,
} from "@clawdi/shared";
import { parse as parseYaml } from "yaml";
import { buildAgentTargetProjection } from "../lib/ai-provider-projection";
import {
	agentTargetProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderEnvironment,
} from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { buildOpenClawHostedProviderPatch, providerHealthReasons } from "./manifest-providers";

function credential(identity: string, variant?: string): AiProvider {
	const routing = nativeAiProvider(identity, variant);
	if (!routing) throw new Error("Missing native provider fixture");
	return {
		id: "saved-credential",
		configuration_mode: "native",
		native_provider: identity,
		native_variant: variant,
		type: routing.type,
		base_url: routing.base_url,
		api_mode: routing.api_mode,
		runtime_env_name: routing.runtime_env_name,
		auth:
			identity === "openai-codex"
				? { type: "agent_profile", tool: "codex", profile: "default" }
				: { type: "api_key", source: "managed" },
	};
}

describe("native provider credentials", () => {
	test("connects every supported route without projecting a Hermes model or catalog", () => {
		for (const route of NATIVE_AI_PROVIDERS) {
			const catalog: AiProviderCatalog = {
				schema_version: 1,
				providers: [credential(route.id, route.variant ?? undefined)],
			};
			const projection = buildAgentTargetProjection("hermes", catalog);
			expect(projection.primary_model).toBeNull();
			expect(parseYaml(projection.files[0]?.content ?? "")).toEqual({});
		}
	});

	test("preserves an existing model choice and enables the official OpenClaw catalog", () => {
		const catalog: AiProviderCatalog = { schema_version: 1, providers: [credential("gemini")] };
		const patch = buildOpenClawHostedProviderPatch(
			{ catalog, primaryModel: { provider_id: "saved-credential", model: "existing-user-model" } },
			[],
		);
		const config = JSON.parse(patch.content);
		expect(config.plugins.entries.google.enabled).toBe(true);
		expect(config.models).toEqual({
			mode: "merge",
			providers: {
				google: {
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					auth: "api-key",
					apiKey: { source: "env", provider: "clawdi-native", id: "GEMINI_API_KEY" },
				},
			},
		});
		expect(config.agents?.defaults?.model).toBeUndefined();
		expect(config.models.providers.google.models).toBeUndefined();
	});

	test("keeps mixed-protocol OpenCode catalogs and request handling in their official plugins", () => {
		for (const variant of ["zen", "go"]) {
			const patch = JSON.parse(
				buildOpenClawHostedProviderPatch(
					{
						catalog: { schema_version: 1, providers: [credential("opencode", variant)] },
						primaryModel: null,
					},
					[],
				).content,
			);
			const id = variant === "zen" ? "opencode" : "opencode-go";
			expect(patch.plugins.entries[id]).toEqual({ enabled: true });
			expect(patch.models.providers[id]).toEqual({
				baseUrl: variant === "zen" ? "https://opencode.ai/zen/v1" : "https://opencode.ai/zen/go/v1",
				auth: "api-key",
				apiKey: { source: "env", provider: "clawdi-native", id: "OPENCODE_API_KEY" },
			});
		}
	});

	test("keeps a managed embedding catalog beside a native chat credential", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
				credential("openai"),
				{
					id: "clawdi",
					type: "custom_openai_compatible",
					managed_by: "clawdi",
					base_url: "https://managed.example.test/v1",
					api_mode: "openai_responses",
					runtime_env_name: "CLAWDI_AI_API_KEY",
					auth: { type: "api_key", source: "managed" },
					models: [{ id: "embedding-test", capabilities: { embeddings: true } }],
				},
			],
			defaults: { embedding_provider_id: "clawdi" },
		};
		const patch = JSON.parse(
			buildOpenClawHostedProviderPatch({ catalog, primaryModel: null }, []).content,
		);
		expect(patch.models.mode).toBe("merge");
		expect(patch.models.providers.clawdi.models.map((model: { id: string }) => model.id)).toEqual([
			"embedding-test",
		]);
		expect(patch.memory.search).toEqual({ provider: "clawdi", model: "embedding-test" });
		expect(patch.agents.defaults.model).toBeUndefined();
	});

	test("normalizes a deployment-scoped managed embedding even with null primary", () => {
		const id = "clawdi-v2-deployment-1234567890123456";
		const input = agentTargetProjectionInput({
			primaryModel: null,
			catalog: {
				schema_version: 1,
				providers: [
					credential("openai"),
					{
						id,
						type: "custom_openai_compatible",
						managed_by: "clawdi",
						api_mode: "openai_chat",
						base_url: "https://managed.example.test/v1",
						runtime_env_name: "CLAWDI_AI_API_KEY",
						auth: { type: "api_key", source: "managed" },
						models: [{ id: "embed", capabilities: { embeddings: true } }],
					},
				],
				defaults: { embedding_provider_id: id },
			},
		});
		expect(input?.primaryModel).toBeNull();
		expect(input?.catalog.defaults?.embedding_provider_id).toBe("clawdi");
		expect(input?.catalog.providers[1]).toMatchObject({
			id: "clawdi",
			api_mode: "openai_responses",
		});
	});

	test("unbinding a native credential removes only owned auth fields", () => {
		const patch = JSON.parse(buildOpenClawHostedProviderPatch(null, [], ["google"]).content);
		expect(patch).toEqual({
			models: { providers: { google: { apiKey: null, auth: null, baseUrl: null } } },
		});
	});

	test("resolves native region auth and endpoint variables without a primary model", () => {
		const manifest: RuntimeManifest = {
			schemaVersion: "clawdi.runtimeDesiredState.v1",
			deploymentId: "native-test",
			environmentId: "native-test",
			instanceId: "native-test",
			generation: 1,
			issuedAt: "2026-09-07T00:00:00Z",
			runtime: "hermes",
			controlPlane: { apiUrl: "https://core.example.test" },
			recovery: {},
			runtimes: {
				hermes: {
					enabled: true,
					providerMode: "configured",
					provider_ids: ["saved-credential"],
					primary_model: null,
					services: {},
				},
			},
			projection: {
				providers: {
					"saved-credential": {
						kind: "openai-compatible",
						type: "custom_openai_compatible",
						configurationMode: "native",
						nativeProvider: "alibaba-coding-plan",
						baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
						apiMode: "openai_chat",
						runtimeEnvName: "ALIBABA_CODING_PLAN_API_KEY",
						apiKeySecretRef: "secret://provider.saved-credential.apiKey",
					},
				},
			},
		};
		expect(hostedAiProviderCatalog(manifest, "hermes")?.primaryModel).toBeNull();
		expect(hostedProviderEnvironment(manifest, "hermes")).toEqual({
			placeholderEnv: {},
			configEnv: { ALIBABA_CODING_PLAN_BASE_URL: "https://coding-intl.dashscope.aliyuncs.com/v1" },
			secretEnv: { ALIBABA_CODING_PLAN_API_KEY: "secret://provider.saved-credential.apiKey" },
		});
		expect(
			providerHealthReasons(
				{ configurationMode: "native", baseUrl: "https://api.openai.com/v1" },
				true,
			),
		).toEqual([]);
		// Runtime wire metadata can differ from the portable saved connection.
		for (const route of NATIVE_AI_PROVIDERS.filter((entry) => entry.id !== "openai-codex")) {
			for (const runtime of ["hermes", "openclaw"] as const) {
				const target = nativeAiProviderRuntime(route, runtime);
				const env = runtime === "hermes" ? route.hermes.env : route.runtime_env_name;
				const projection = {
					kind: "openai-compatible",
					type: target.type,
					configurationMode: "native",
					nativeProvider: route[runtime].provider,
					baseUrl: target.base_url,
					apiMode: target.api_mode,
					runtimeEnvName: env,
					apiKeySecretRef: "secret://provider.saved-credential.apiKey",
				} as const;
				const bundle: RuntimeManifest = {
					...manifest,
					runtime,
					runtimes: { [runtime]: { ...manifest.runtimes.hermes } },
					projection: { providers: { "saved-credential": projection } },
				};
				expect(
					nativeAiProviderForRuntime(runtime, projection.nativeProvider, projection.baseUrl)?.id,
				).toBe(route.id);
				const input = hostedAiProviderCatalog(bundle, runtime);
				expect(input?.catalog.providers[0]).toMatchObject({
					type: route.type,
					base_url: route.base_url,
					api_mode: route.api_mode,
					native_provider: route.id,
					native_variant: route.variant ?? undefined,
				});
				if (!input) throw new Error("Native credential projection is missing");
				expect(buildAgentTargetProjection(runtime, input.catalog).primary_model).toBeNull();
				if (runtime === "hermes" && route.hermes.base_url_env) {
					expect(
						hostedProviderEnvironment(bundle, runtime).configEnv[route.hermes.base_url_env],
					).toBe(target.base_url);
				}
			}
		}
	});
});
