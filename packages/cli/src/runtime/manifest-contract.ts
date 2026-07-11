import { z } from "zod";
import { isValidSemver } from "../lib/semver";
import { egressProfileInputBundleSchema } from "./egress-profiles";
import {
	runtimeNameSchema,
	runtimeRunSettingsSchema,
	runtimeServiceNameSchema,
} from "./run-config";

export const RUNTIME_DESIRED_STATE_SCHEMA_VERSION = "clawdi.runtimeDesiredState.v1";

export const OFFICIAL_INSTALL_URLS: Record<string, string> = {
	openclaw: "https://openclaw.ai/install-cli.sh",
	hermes: "https://hermes-agent.nousresearch.com/install.sh",
};

export const OFFICIAL_INSTALL_ARGS: Record<string, string[]> = {
	openclaw: ["--json", "--no-onboard"],
	hermes: ["--skip-setup", "--skip-browser", "--non-interactive"],
};

const hostedRuntimeChoiceSchema = z.enum(["openclaw", "hermes"]);
const semverSchema = z.string().min(1).refine(isValidSemver, "must be a semver string");

const installSchema = z.object({
	authority: z.literal("official"),
	method: z.literal("official-installer"),
	url: z.string().url(),
	home: z.string().min(1),
	args: z.array(z.string()).default([]),
});

const runtimeSchema = z.object({
	enabled: z.boolean(),
	updateChannel: z.string().min(1).optional(),
	install: installSchema.optional(),
	run: runtimeRunSettingsSchema.optional(),
	services: z.record(runtimeServiceNameSchema, runtimeRunSettingsSchema).default({}),
	provider_ids: z.array(z.string().min(1)).optional(),
	primary_model: z
		.object({
			provider_id: z.string().min(1),
			model: z.string().min(1),
		})
		.optional(),
});

const cliPayloadPolicySchema = z.object({
	version: z.string().min(1).optional(),
	channel: z.string().min(1).optional(),
	source: z.string().min(1).optional(),
	packageSpec: z.string().min(1).optional(),
	registry: z.string().min(1).optional(),
});

const hostedCliPayloadPolicySchema = z
	.object({
		// The image env seeds pre-manifest bootstrap only; Cloud owns every hosted update after that.
		source: z.literal("npm:clawdi"),
		packageSpec: z.string().min(1),
		registry: z.literal("https://registry.npmjs.org"),
	})
	.strict();

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const egressEngineSchema = z.object({
	type: z.literal("mitmproxy"),
	version: z.string().min(1),
	url: z.string().url(),
	sha256: sha256Schema,
});

export type EgressEnginePin = z.infer<typeof egressEngineSchema>;

export const DEFAULT_CLAWDI_CLI_POLICY = {
	source: "npm:clawdi",
	packageSpec: "clawdi@latest",
} satisfies z.infer<typeof cliPayloadPolicySchema>;

const liveSyncAgentSchema = z.object({
	agentType: runtimeNameSchema,
	environmentId: z.string().min(1),
});

const liveSyncSchema = z.object({
	enabled: z.boolean().optional(),
	agents: z.array(liveSyncAgentSchema).default([]),
});

const tcpPortSchema = z.number().int().min(1).max(65535);
const runtimeBridgeSurfaceNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a lowercase surface id");

export const runtimeBridgeSurfaceSchema = z.object({
	name: runtimeBridgeSurfaceNameSchema,
	kind: z.enum(["control-ui"]),
	listenHost: z.string().min(1).optional(),
	listenPort: tcpPortSchema,
	upstreamHost: z.string().min(1).default("127.0.0.1"),
	upstreamPort: tcpPortSchema,
});

const runtimeBridgeSchema = z.object({
	surfaces: z.array(runtimeBridgeSurfaceSchema).default([]),
});

const runtimeProjectionSchema = z.object({
	sourceSchemaVersion: z.string().min(1).optional(),
	system: z.unknown().nullable().optional(),
	providers: z.record(z.string().min(1), z.unknown()).optional(),
	channels: z.record(z.string().min(1), z.unknown()).optional(),
	channelCredentials: z.array(z.unknown()).optional(),
	aiProviders: z.record(z.string().min(1), z.unknown()).optional(),
	mcp: z.unknown().optional(),
	tools: z.unknown().optional(),
});

const runtimeDesiredStateShape = {
	deploymentId: z.string().min(1),
	environmentId: z.string().min(1),
	instanceId: z.string().min(1),
	generation: z.number().int().nonnegative(),
	minimumCliVersion: semverSchema.optional(),
	issuedAt: z.string().min(1),
	expiresAt: z.string().min(1).optional(),
	workspaceRoot: z.string().min(1).optional(),
	runtime: hostedRuntimeChoiceSchema.optional(),
	controlPlane: z.object({
		apiUrl: z.string().url(),
	}),
	clawdiCli: cliPayloadPolicySchema.optional(),
	egressEngine: egressEngineSchema.optional(),
	runtimes: z.record(runtimeNameSchema, runtimeSchema),
	bridge: runtimeBridgeSchema.optional(),
	projection: runtimeProjectionSchema.optional(),
	egressProfiles: egressProfileInputBundleSchema.optional(),
	liveSync: liveSyncSchema.optional(),
	recovery: z
		.object({
			cacheManifest: z.boolean().optional(),
			allowOfflineBoot: z.boolean().optional(),
		})
		.default({}),
};

function addForbiddenFieldIssue(ctx: z.RefinementCtx, field: string, message?: string): void {
	ctx.addIssue({
		code: "custom",
		message: message ?? `Unrecognized key: "${field}"`,
		path: [field],
	});
}

export const manifestSchema = z
	.object({
		schemaVersion: z.literal(RUNTIME_DESIRED_STATE_SCHEMA_VERSION),
		...runtimeDesiredStateShape,
		secrets: z.unknown().optional(),
	})
	.superRefine((manifest, ctx) => {
		if ("secrets" in manifest) addForbiddenFieldIssue(ctx, "secrets");
	})
	.transform(({ secrets: _secrets, ...manifest }) => manifest);

const hostedControlPlaneSchema = z
	.object({
		manifestUrl: z.string().url().optional(),
		cloudApiUrl: z.string().url().optional(),
		apiUrl: z.unknown().optional(),
	})
	.superRefine((controlPlane, ctx) => {
		if ("apiUrl" in controlPlane) {
			addForbiddenFieldIssue(ctx, "apiUrl", "hosted runtime controlPlane must use cloudApiUrl");
		}
	})
	.transform(({ apiUrl: _apiUrl, ...controlPlane }) => controlPlane);

const hostedRuntimeInstallSchema = z.object({
	source: z.literal("official"),
	channel: z.string().min(1).optional(),
	args: z.array(z.string()).optional(),
});

const hostedRuntimeEntrySchema = z.object({
	enabled: z.boolean(),
	install: hostedRuntimeInstallSchema.optional(),
	run: runtimeRunSettingsSchema.optional(),
	services: z.record(runtimeServiceNameSchema, runtimeRunSettingsSchema).default({}),
	provider_ids: z.array(z.string().min(1)).optional(),
	providerIds: z.array(z.string().min(1)).optional(),
	primary_model: z
		.union([
			z.string().min(1),
			z.object({
				provider_id: z.string().min(1).optional(),
				providerId: z.string().min(1).optional(),
				model: z.string().min(1),
			}),
		])
		.optional(),
	primaryModel: z
		.object({
			provider_id: z.string().min(1).optional(),
			providerId: z.string().min(1).optional(),
			model: z.string().min(1),
		})
		.optional(),
	paths: z
		.object({
			home: z.string().min(1).optional(),
			workspace: z.string().min(1).optional(),
		})
		.optional(),
});

const hostedProviderCapabilitiesSchema = z.object({
	chat: z.boolean().optional(),
	responses: z.boolean().optional(),
	tools: z.boolean().optional(),
	vision: z.boolean().optional(),
	embeddings: z.boolean().optional(),
	image_generation: z.boolean().optional(),
});

const hostedProviderModelCostSchema = z.object({
	input: z.number().nonnegative(),
	output: z.number().nonnegative(),
	cache_read: z.number().nonnegative().optional(),
	cache_write: z.number().nonnegative().optional(),
});

const hostedProviderModelSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1).optional(),
	alias: z.string().min(1).optional(),
	api_mode: z.string().min(1).optional(),
	input_modalities: z.array(z.string().min(1)).optional(),
	supports_vision: z.boolean().optional(),
	supports_tools: z.boolean().optional(),
	supports_reasoning: z.boolean().optional(),
	context_window: z.number().int().positive().optional(),
	max_tokens: z.number().int().positive().optional(),
	cost: hostedProviderModelCostSchema.optional(),
	capabilities: hostedProviderCapabilitiesSchema.optional(),
});

const hostedProviderAuthSchema = z.object({
	type: z.string().min(1),
	tool: z.string().min(1).optional(),
	profile: z.string().min(1).optional(),
	source: z.string().min(1).optional(),
	ref: z.string().min(1).optional(),
});

const hostedProviderSchema = z.object({
	kind: z.string().min(1).optional(),
	type: z.string().min(1).optional(),
	baseUrl: z.string().url().optional(),
	base_url: z.string().url().optional(),
	model: z.string().min(1).optional(),
	models: z.array(hostedProviderModelSchema).optional(),
	apiMode: z.string().min(1).optional(),
	api_mode: z.string().min(1).optional(),
	managed_by: z.string().min(1).optional(),
	runtimeEnvName: z.string().min(1).optional(),
	runtime_env_name: z.string().min(1).optional(),
	apiKeySecretRef: z.string().min(1).nullable().optional(),
	api_key_secret_ref: z.string().min(1).nullable().optional(),
	apiKeyRequired: z.boolean().optional(),
	status: z.string().min(1).optional(),
	error: z
		.object({
			code: z.string().min(1),
			message: z.string().min(1).optional(),
		})
		.optional(),
	auth: hostedProviderAuthSchema.optional(),
});

export const hostedRuntimeManifestSchema = z.preprocess(
	(value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
		const manifest = value as Record<string, unknown>;
		if (manifest.runtime !== undefined) return value;
		const runtimes = manifest.runtimes;
		if (typeof runtimes !== "object" || runtimes === null || Array.isArray(runtimes)) return value;
		const runtimeKeys = Object.keys(runtimes).filter(
			(runtime) => hostedRuntimeChoiceSchema.safeParse(runtime).success,
		);
		if (runtimeKeys.length !== 1) return value;
		return { ...manifest, runtime: runtimeKeys[0] };
	},
	z
		.object({
			schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
			runtime: hostedRuntimeChoiceSchema,
			deploymentId: z.string().min(1),
			environmentId: z.string().min(1).optional(),
			appId: z.string().min(1).optional(),
			instanceId: z.string().min(1),
			generation: z.number().int().nonnegative(),
			minimumCliVersion: semverSchema.optional(),
			issuedAt: z.string().min(1),
			expiresAt: z.string().min(1).optional(),
			system: z
				.object({
					user: z.string().min(1).optional(),
					home: z.string().min(1).optional(),
					workspace: z.string().min(1).optional(),
					persistentPaths: z.array(z.string().min(1)).optional(),
				})
				.optional(),
			controlPlane: hostedControlPlaneSchema,
			clawdiCli: hostedCliPayloadPolicySchema,
			egressEngine: egressEngineSchema.optional(),
			runtimes: z.record(runtimeNameSchema, hostedRuntimeEntrySchema),
			bridge: runtimeBridgeSchema.optional(),
			providers: z.record(z.string().min(1), hostedProviderSchema).optional(),
			liveSync: liveSyncSchema.optional(),
			egressProfiles: z.unknown().optional(),
			mcp: z.unknown().optional(),
			tools: z.unknown().optional(),
			recovery: z
				.object({
					cacheManifest: z.boolean().optional(),
					allowOfflineBoot: z.boolean().optional(),
				})
				.optional(),
		})
		.superRefine((manifest, ctx) => {
			const runtimeKeys = Object.keys(manifest.runtimes);
			const unexpectedRuntimeKeys = runtimeKeys.filter((runtime) => runtime !== manifest.runtime);
			if (!manifest.runtimes[manifest.runtime]) {
				ctx.addIssue({
					code: "custom",
					message: `runtimes.${manifest.runtime} must be present for selected runtime`,
					path: ["runtimes", manifest.runtime],
				});
			}
			for (const key of unexpectedRuntimeKeys) {
				ctx.addIssue({
					code: "custom",
					message: "hosted runtime manifests must declare exactly one selected runtime",
					path: ["runtimes", key],
				});
			}
			if (manifest.runtimes[manifest.runtime]?.enabled !== true) {
				ctx.addIssue({
					code: "custom",
					message: "selected runtime must be enabled",
					path: ["runtimes", manifest.runtime, "enabled"],
				});
			}
			const surfaces = manifest.bridge?.surfaces ?? [];
			if (manifest.runtime === "openclaw" && surfaces.length > 0) {
				const surface = surfaces.at(0);
				if (
					surfaces.length !== 1 ||
					surface?.name !== "openclaw" ||
					surface?.kind !== "control-ui" ||
					surface?.listenPort !== 28789 ||
					surface?.upstreamHost !== "127.0.0.1" ||
					surface?.upstreamPort !== 18789
				) {
					ctx.addIssue({
						code: "custom",
						message: "openclaw bridge surface must be openclaw control-ui 28789 -> 127.0.0.1:18789",
						path: ["bridge", "surfaces"],
					});
				}
			}
			if (manifest.runtime === "hermes") {
				if (surfaces.length !== 1) {
					ctx.addIssue({
						code: "custom",
						message: "hermes must declare exactly one bridge surface",
						path: ["bridge", "surfaces"],
					});
					return;
				}
				const surface = surfaces.at(0);
				if (
					surface?.name !== "hermes" ||
					surface?.kind !== "control-ui" ||
					surface?.listenPort !== 28793 ||
					surface?.upstreamHost !== "127.0.0.1" ||
					surface?.upstreamPort !== 9119
				) {
					ctx.addIssue({
						code: "custom",
						message: "hermes bridge surface must be hermes control-ui 28793 -> 127.0.0.1:9119",
						path: ["bridge", "surfaces", 0],
					});
				}
			}
		}),
);

export const hostedRuntimeManifestResponseSchema = z.object({
	manifest: hostedRuntimeManifestSchema,
	secretValues: z.record(z.string().min(1), z.string()).default({}),
});

export type RuntimeManifest = z.output<typeof manifestSchema>;
export type RuntimeInstall = z.infer<typeof installSchema>;
export type HostedRuntimeManifest = z.infer<typeof hostedRuntimeManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;
export type RuntimeBridgeSurfaceInput = z.input<typeof runtimeBridgeSurfaceSchema>;
export type RuntimeBridgeSurfaceSpec = z.output<typeof runtimeBridgeSurfaceSchema>;
