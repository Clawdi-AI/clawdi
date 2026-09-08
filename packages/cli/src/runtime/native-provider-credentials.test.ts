import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AiProviderCatalog,
	NATIVE_AI_PROVIDERS,
	nativeAiProvider,
	nativeAiProviderRuntime,
} from "@clawdi/shared";
import { createOpenClawHostedContext } from "./hosted-openclaw-context";
import {
	agentTargetProjectionInput,
	hostedAiProviderCatalog,
	hostedProviderConfiguration,
	hostedProviderEnvironment,
	nativeProviderConnections,
} from "./hosted-provider-resolution";
import type { RuntimeManifest } from "./manifest-contract";
import { buildOpenClawHostedProviderPatch, providerHealthReasons } from "./manifest-providers";
import {
	buildNativeOpenClawProviderPatch,
	discoverNativeOpenClawProviderIds,
} from "./openclaw-native-provider";

function bundle(
	identity: string,
	variant?: string,
	runtime: "hermes" | "openclaw" = "openclaw",
): RuntimeManifest {
	const route = nativeAiProvider(identity, variant);
	if (!route) throw new Error("Missing native fixture");
	const target = nativeAiProviderRuntime(route, runtime);
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "native-test",
		environmentId: "native-test",
		instanceId: "native-test",
		generation: 1,
		issuedAt: "2026-09-07T00:00:00Z",
		runtime,
		controlPlane: { apiUrl: "https://core.example.test" },
		recovery: {},
		runtimes: {
			[runtime]: {
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
					type: target.type,
					configurationMode: "native",
					nativeProvider: route[runtime].provider,
					baseUrl: target.base_url,
					apiMode: target.api_mode,
					runtimeEnvName: runtime === "hermes" ? route.hermes.env : route.runtime_env_name,
					...(identity === "openai-codex"
						? { auth: { type: "agent_profile", tool: "codex", profile: "default" } }
						: { apiKeySecretRef: "secret://provider.saved-credential.apiKey" }),
				},
			},
		},
	};
}
function nativePatch(identity: string, variant?: string) {
	return buildNativeOpenClawProviderPatch(
		nativeProviderConnections(bundle(identity, variant), "openclaw"),
		[],
	).config;
}

describe("native provider credentials", () => {
	test("discovers only valid owned routing and env references, preserving foreign or modified entries", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-native-discovery-"));
		const context = createOpenClawHostedContext(bundle("gemini"), root);
		const path = context.configPath;
		mkdirSync(context.stateRoot, { recursive: true });
		const discover = () =>
			discoverNativeOpenClawProviderIds("unavailable-openclaw", context, root, {});
		try {
			expect(discover()).toEqual([]);
			const owned = {
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				auth: "api-key",
				apiKey: { source: "env", provider: "clawdi-native", id: "GEMINI_API_KEY" },
				models: [{ id: "user-model" }],
			};
			const candidates = [
				[owned, ["google"]],
				[{ ...owned, apiKey: "user-key" }, []],
				[{ ...owned, apiKey: { ...owned.apiKey, provider: "default" } }, []],
				[{ ...owned, apiKey: { ...owned.apiKey, source: "file" } }, []],
				[{ ...owned, apiKey: { ...owned.apiKey, id: "OTHER_KEY" } }, []],
				[{ ...owned, apiKey: { ...owned.apiKey, extra: true } }, []],
				[{ ...owned, baseUrl: "https://user.example/v1" }, []],
				[{ ...owned, auth: "oauth" }, []],
			] as const;
			for (const [provider, expected] of candidates) {
				writeFileSync(path, JSON.stringify({ models: { providers: { google: provider } } }));
				expect(discover()).toEqual([...expected]);
			}
			writeFileSync(
				path,
				`{
  // A failed convergence can leave authored native JSON5 behind.
  models: { providers: { google: ${JSON.stringify(owned)}, }, },
}`,
			);
			expect(discover()).toEqual(["google"]);
			writeFileSync(path, "invalid config");
			expect(() => discover()).toThrow("ownership could not be inspected");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("uses native include resolution and accepts only namespaced env references after redaction", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-native-includes-"));
		const context = createOpenClawHostedContext(bundle("gemini"), root);
		mkdirSync(context.stateRoot, { recursive: true });
		const command = join(root, "openclaw");
		const report = join(root, "report.json");
		writeFileSync(
			command,
			`#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.slice(2).join(" ") !== "config get models --json") process.exit(42);
process.stdout.write(fs.readFileSync(${JSON.stringify(report)}, "utf8"));
`,
			{ mode: 0o700 },
		);
		try {
			writeFileSync(context.configPath, "{models: {$include: './providers.json',},}");
			const owned = {
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				auth: "api-key",
				apiKey: { source: "env", provider: "clawdi-native", id: "__OPENCLAW_REDACTED__" },
			};
			writeFileSync(
				report,
				JSON.stringify({
					providers: {
						google: owned,
						openai: {
							...owned,
							baseUrl: "https://api.openai.com/v1",
							apiKey: { ...owned.apiKey, provider: "personal" },
						},
					},
				}),
			);
			expect(discoverNativeOpenClawProviderIds(command, context, root, {})).toEqual(["google"]);
			writeFileSync(report, '{"mode":"merge"}');
			expect(discoverNativeOpenClawProviderIds(command, context, root, {})).toEqual([]);

			writeFileSync(report, "private native diagnostic");
			expect(() => discoverNativeOpenClawProviderIds(command, context, root, {})).toThrow(
				"OpenClaw native provider ownership could not be inspected",
			);
			writeFileSync(command, "#!/bin/sh\nprintf 'private native error' >&2\nexit 1\n", {
				mode: 0o700,
			});
			expect(() => discoverNativeOpenClawProviderIds(command, context, root, {})).toThrow(
				"OpenClaw native provider ownership could not be inspected",
			);
			writeFileSync(context.configPath, "{$include: './gateway.json5'}");
			expect(context.sdk.configMutation).toBeNull();
			const missingStderr =
				"Config path not found: models. Run openclaw config validate to inspect config shape.\n";
			const missingStdout = `${JSON.stringify(
				{
					ok: false,
					error: {
						type: "cli_error",
						message:
							"Config path is valid but unset: models. The runtime default applies until you set an authored value with openclaw config set models <value>.",
					},
				},
				null,
				2,
			)}\n`;
			const reports = [
				{ status: 1, stdout: "", stderr: missingStderr, missing: true },
				{ status: 1, stdout: missingStdout, stderr: "", missing: true },
				{
					status: 1,
					stdout: JSON.stringify({ error: JSON.parse(missingStdout).error, ok: false }),
					stderr: "",
					missing: true,
				},
				{
					status: 1,
					stdout: JSON.stringify({ ...JSON.parse(missingStdout), diagnostic: "unexpected" }),
					stderr: "",
					missing: false,
				},
				{
					status: 1,
					stdout: missingStdout.replace('"cli_error"', '"other_error"'),
					stderr: "",
					missing: false,
				},
				{ status: 2, stdout: "", stderr: missingStderr, missing: false },
				{ status: 1, stdout: "unexpected diagnostic", stderr: missingStderr, missing: false },
				{ status: 1, stdout: missingStdout, stderr: "unexpected diagnostic", missing: false },
				{ status: 1, stdout: "", stderr: `private diagnostic\n${missingStderr}`, missing: false },
				{
					status: 1,
					stdout: missingStdout.replace("models.", "models.providers."),
					stderr: "",
					missing: false,
				},
				{ status: 1, stdout: "", stderr: "Config path not found: models\n", missing: false },
			];
			for (const report of reports) {
				writeFileSync(
					command,
					`#!/usr/bin/env node
if (process.env.NO_COLOR !== "1" || process.env.FORCE_COLOR !== undefined || process.env.CLICOLOR_FORCE !== undefined) process.exit(42);
process.stdout.write(${JSON.stringify(report.stdout)});
process.stderr.write(${JSON.stringify(report.stderr)});
process.exit(${report.status});
`,
					{ mode: 0o700 },
				);
				const discover = () =>
					discoverNativeOpenClawProviderIds(command, context, root, {
						FORCE_COLOR: "1",
						CLICOLOR_FORCE: "1",
					});
				if (report.missing) expect(discover()).toEqual([]);
				else expect(discover).toThrow("OpenClaw native provider ownership could not be inspected");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("routes all native connections directly without creating catalogs or model selections", () => {
		for (const route of NATIVE_AI_PROVIDERS) {
			for (const runtime of ["hermes", "openclaw"] as const) {
				const manifest = bundle(route.id, route.variant ?? undefined, runtime);
				const resolved = hostedProviderConfiguration(manifest, runtime);
				expect(resolved.catalog).toBeNull();
				expect(resolved.native[0]?.routing).toEqual(nativeAiProviderRuntime(route, runtime));
				const config = buildNativeOpenClawProviderPatch(resolved.native, []).config;
				expect(config.agents).toBeUndefined();
				expect(JSON.stringify(config)).not.toContain('"models":[');
			}
		}
	});

	test("writes only native routing and namespaced authentication", () => {
		expect(nativePatch("gemini")).toEqual({
			models: {
				mode: "merge",
				providers: {
					google: {
						baseUrl: "https://generativelanguage.googleapis.com/v1beta",
						auth: "api-key",
						apiKey: { source: "env", provider: "clawdi-native", id: "GEMINI_API_KEY" },
					},
				},
			},
			secrets: { providers: { "clawdi-native": { source: "env" } } },
		});
	});

	test("rejects invalid native metadata before projection", () => {
		const manifest = bundle("gemini");
		const provider = manifest.projection?.providers?.["saved-credential"];
		if (!provider) throw new Error("Missing fixture");
		provider.apiMode = "openai_chat";
		expect(() => hostedProviderConfiguration(manifest, "openclaw")).toThrow(
			"Invalid native provider",
		);
	});

	test("rejects credential environment collisions across native and catalog paths", () => {
		const manifest = bundle("anthropic");
		const providers = manifest.projection?.providers;
		const runtime = manifest.runtimes.openclaw;
		if (!providers || !runtime) throw new Error("Missing fixture");
		providers.catalog = {
			kind: "openai-compatible",
			type: "custom_openai_compatible",
			baseUrl: "https://catalog.example.test/v1",
			apiMode: "openai_chat",
			runtimeEnvName: "ANTHROPIC_API_KEY",
			apiKeySecretRef: "secret://provider.catalog.apiKey",
			models: [{ id: "chat" }],
		};
		runtime.provider_ids = ["saved-credential", "catalog"];
		runtime.primary_model = { provider_id: "catalog", model: "chat" };
		expect(() => hostedProviderConfiguration(manifest, "openclaw")).toThrow(
			"has multiple providers",
		);
		expect(() => hostedProviderEnvironment(manifest, "openclaw")).toThrow("has multiple providers");
	});

	test("keeps a managed embedding catalog beside a native chat credential", () => {
		const catalog: AiProviderCatalog = {
			schema_version: 1,
			providers: [
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
			buildOpenClawHostedProviderPatch({ catalog, primaryModel: null }, [], "merge").content,
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
		expect(input?.catalog.providers[0]).toMatchObject({
			id: "clawdi",
			api_mode: "openai_responses",
		});
	});

	test("unbinding a native credential removes only owned auth fields", () => {
		const patch = buildNativeOpenClawProviderPatch([], ["google"]).config;
		expect(patch).toEqual({
			models: { providers: { google: { apiKey: null, auth: null, baseUrl: null } } },
		});
	});

	test("derives native regional environment without a model", () => {
		const manifest = bundle("qwen-dashscope", "coding-global", "hermes");
		expect(hostedAiProviderCatalog(manifest, "hermes")).toBeNull();
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
	});
});
