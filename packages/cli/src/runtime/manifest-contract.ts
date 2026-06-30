import { z } from "zod";
import { mitmProfileInputBundleSchema } from "./mitm-profiles";
import { runtimeNameSchema, runtimeRunSettingsSchema } from "./run-config";

export const RUNTIME_DESIRED_STATE_SCHEMA_VERSION = "clawdi.runtimeDesiredState.v1";

export const OFFICIAL_INSTALL_URLS: Record<string, string> = {
	openclaw: "https://openclaw.ai/install-cli.sh",
	hermes: "https://hermes-agent.nousresearch.com/install.sh",
};

export const OFFICIAL_INSTALL_ARGS: Record<string, string[]> = {
	openclaw: ["--json", "--no-onboard"],
	hermes: ["--skip-setup", "--skip-browser", "--non-interactive"],
};

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
	controlPlane: z
		.object({
			apiUrl: z.string().url(),
		})
		.strict(),
	clawdiCli: cliPayloadPolicySchema.optional(),
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
		paths: z
			.object({
				home: z.string().min(1).optional(),
				workspace: z.string().min(1).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

const hostedProviderAuthSchema = z
	.object({
		type: z.literal("agent_profile"),
		tool: z.literal("codex"),
		profile: z.string().min(1),
	})
	.strict();

export const hostedRuntimeManifestSchema = z
	.object({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
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
						apiMode: z.string().min(1).optional(),
						runtimeEnvName: z.string().min(1).optional(),
						apiKeySecretRef: z.string().min(1).nullable().optional(),
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
	.strict();

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
