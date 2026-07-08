import { z } from "zod";
import { mitmProfileInputBundleSchema } from "./mitm-profiles";
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

const installSchema = z
	.object({
		authority: z.literal("official"),
		method: z.literal("official-installer"),
		url: z.string().url(),
		home: z.string().min(1),
		args: z.array(z.string()).default([]),
	})
	.strict();

const runtimeSchema = z
	.object({
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
			.strict()
			.optional(),
	})
	.strict();

const cliPayloadPolicySchema = z
	.object({
		version: z.string().min(1).optional(),
		channel: z.string().min(1).optional(),
		source: z.string().min(1).optional(),
		packageSpec: z.string().min(1).optional(),
	})
	.passthrough();

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const mitmproxyArtifactSchema = z
	.object({
		version: z.string().min(1),
		url: z.string().url(),
		sha256: sha256Schema,
	})
	.strict();

export type MitmproxyArtifactPin = z.infer<typeof mitmproxyArtifactSchema>;

export const DEFAULT_CLAWDI_CLI_POLICY = {
	source: "npm:clawdi",
	packageSpec: "clawdi@latest",
} satisfies z.infer<typeof cliPayloadPolicySchema>;

const liveSyncAgentSchema = z
	.object({
		agentType: runtimeNameSchema,
		environmentId: z.string().min(1),
	})
	.strict();

const liveSyncSchema = z
	.object({
		enabled: z.boolean().optional(),
		agents: z.array(liveSyncAgentSchema).default([]),
	})
	.strict();

const tcpPortSchema = z.number().int().min(1).max(65535);
const runtimeBridgeSurfaceNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a lowercase surface id");

export const runtimeBridgeSurfaceSchema = z
	.object({
		name: runtimeBridgeSurfaceNameSchema,
		kind: z.enum(["control-ui"]),
		listenHost: z.string().min(1).optional(),
		listenPort: tcpPortSchema,
		upstreamHost: z.string().min(1).default("127.0.0.1"),
		upstreamPort: tcpPortSchema,
	})
	.strict();

const runtimeBridgeSchema = z
	.object({
		surfaces: z.array(runtimeBridgeSurfaceSchema).default([]),
	})
	.strict();

const runtimeProjectionSchema = z
	.object({
		sourceSchemaVersion: z.string().min(1).optional(),
		system: z.unknown().nullable().optional(),
		providers: z.record(z.string().min(1), z.unknown()).optional(),
		channels: z.record(z.string().min(1), z.unknown()).optional(),
		channelCredentials: z.array(z.unknown()).optional(),
		aiProviders: z.record(z.string().min(1), z.unknown()).optional(),
		mcp: z.unknown().optional(),
		tools: z.unknown().optional(),
	})
	.strict();

const runtimeDesiredStateShape = {
	deploymentId: z.string().min(1),
	environmentId: z.string().min(1),
	instanceId: z.string().min(1),
	generation: z.number().int().nonnegative(),
	issuedAt: z.string().min(1),
	expiresAt: z.string().min(1).optional(),
	workspaceRoot: z.string().min(1).optional(),
	runtime: hostedRuntimeChoiceSchema.optional(),
	controlPlane: z
		.object({
			apiUrl: z.string().url(),
		})
		.strict(),
	clawdiCli: cliPayloadPolicySchema.optional(),
	mitmproxy: mitmproxyArtifactSchema.optional(),
	runtimes: z.record(runtimeNameSchema, runtimeSchema),
	bridge: runtimeBridgeSchema.optional(),
	projection: runtimeProjectionSchema.optional(),
	mitmProfiles: mitmProfileInputBundleSchema.optional(),
	liveSync: liveSyncSchema.optional(),
	recovery: z
		.object({
			cacheManifest: z.boolean().optional(),
			allowOfflineBoot: z.boolean().optional(),
		})
		.strict()
		.default({}),
};

export const manifestSchema = z
	.object({
		schemaVersion: z.literal(RUNTIME_DESIRED_STATE_SCHEMA_VERSION),
		...runtimeDesiredStateShape,
	})
	.strict();

const hostedRuntimeInstallSchema = z
	.object({
		source: z.literal("official"),
		channel: z.string().min(1).optional(),
		args: z.array(z.string()).optional(),
	})
	.passthrough();

const hostedRuntimeEntrySchema = z
	.object({
		enabled: z.boolean(),
		install: hostedRuntimeInstallSchema.optional(),
		run: runtimeRunSettingsSchema.optional(),
		services: z.record(runtimeServiceNameSchema, runtimeRunSettingsSchema).default({}),
		provider_ids: z.array(z.string().min(1)).optional(),
		providerIds: z.array(z.string().min(1)).optional(),
		primary_model: z
			.union([
				z.string().min(1),
				z
					.object({
						provider_id: z.string().min(1).optional(),
						providerId: z.string().min(1).optional(),
						model: z.string().min(1),
					})
					.passthrough(),
			])
			.optional(),
		primaryModel: z
			.object({
				provider_id: z.string().min(1).optional(),
				providerId: z.string().min(1).optional(),
				model: z.string().min(1),
			})
			.passthrough()
			.optional(),
		paths: z
			.object({
				home: z.string().min(1).optional(),
				workspace: z.string().min(1).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

const hostedProviderAuthSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("agent_profile"),
			tool: z.literal("codex"),
			profile: z.string().min(1),
		})
		.strict(),
	z
		.object({
			type: z.literal("api_key"),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("secret_ref"),
		})
		.passthrough(),
]);

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
			issuedAt: z.string().min(1),
			expiresAt: z.string().min(1).optional(),
			system: z
				.object({
					user: z.string().min(1).optional(),
					home: z.string().min(1).optional(),
					workspace: z.string().min(1).optional(),
					persistentPaths: z.array(z.string().min(1)).optional(),
				})
				.passthrough()
				.optional(),
			controlPlane: z
				.object({
					manifestUrl: z.string().url().optional(),
					cloudApiUrl: z.string().url().optional(),
				})
				.passthrough()
				.refine((value) => !("apiUrl" in value), {
					message: "hosted runtime controlPlane must use cloudApiUrl",
					path: ["apiUrl"],
				}),
			clawdiCli: cliPayloadPolicySchema.optional(),
			mitmproxy: mitmproxyArtifactSchema.optional(),
			runtimes: z.record(runtimeNameSchema, hostedRuntimeEntrySchema),
			bridge: runtimeBridgeSchema.optional(),
			providers: z
				.record(
					z.string().min(1),
					z
						.object({
							kind: z.string().min(1).optional(),
							type: z.string().min(1).optional(),
							baseUrl: z.string().url().optional(),
							model: z.string().min(1).optional(),
							models: z.array(z.unknown()).optional(),
							apiMode: z.string().min(1).optional(),
							managed_by: z.enum(["user", "clawdi"]).optional(),
							runtimeEnvName: z.string().min(1).optional(),
							apiKeySecretRef: z.string().min(1).nullable().optional(),
							apiKeyRequired: z.boolean().optional(),
							status: z.enum(["ok", "error", "disabled"]).optional(),
							error: z
								.object({
									code: z.string().min(1),
									message: z.string().min(1).optional(),
								})
								.passthrough()
								.optional(),
							auth: hostedProviderAuthSchema.optional(),
						})
						.passthrough(),
				)
				.optional(),
			liveSync: liveSyncSchema.optional(),
			mitmProfiles: z.unknown().optional(),
			mcp: z.unknown().optional(),
			tools: z.unknown().optional(),
			recovery: z
				.object({
					cacheManifest: z.boolean().optional(),
					allowOfflineBoot: z.boolean().optional(),
				})
				.passthrough()
				.optional(),
		})
		.strict()
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
				ctx.addIssue({
					code: "custom",
					message: "openclaw is exposed natively and must not declare bridge surfaces",
					path: ["bridge", "surfaces"],
				});
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

export const hostedRuntimeManifestResponseSchema = z
	.object({
		manifest: hostedRuntimeManifestSchema,
		secretValues: z.record(z.string().min(1), z.string()).default({}),
	})
	.strict();

export type RuntimeManifest = z.output<typeof manifestSchema>;
export type RuntimeInstall = z.infer<typeof installSchema>;
export type HostedRuntimeManifest = z.infer<typeof hostedRuntimeManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;
export type RuntimeBridgeSurfaceInput = z.input<typeof runtimeBridgeSurfaceSchema>;
export type RuntimeBridgeSurfaceSpec = z.output<typeof runtimeBridgeSurfaceSchema>;
