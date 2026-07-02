import { z } from "zod";
import { mitmProfileInputBundleSchema } from "./mitm-profiles";
import {
	runtimeNameSchema,
	runtimeRunSettingsSchema,
	runtimeServiceNameSchema,
} from "./run-config";

export const RUNTIME_DESIRED_STATE_SCHEMA_VERSION = "clawdi.runtimeDesiredState.v1";

const runtimeTypeSchema = z.enum(["codex", "openclaw", "hermes"]);
const runtimeTargetIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a lowercase runtime target id");

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

const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const runtimeExecutionCommandSchema = z
	.object({
		command: z.string().min(1),
		args: z.array(z.string()).default([]),
		env: z.record(envKeySchema, z.string()).default({}),
		cwd: z.string().min(1).optional(),
	})
	.strict();

const runtimeExternalMcpSchema = z
	.object({
		source: z.enum(["backend-direct", "sidecar-local"]).optional(),
		url: z.string().url().optional(),
		transport: z.enum(["streamable-http"]).default("streamable-http"),
	})
	.strict();

const runtimeTerminalSchema = z
	.object({
		container: z.string().min(1).optional(),
		user: z.string().min(1).optional(),
		cwd: z.string().min(1).optional(),
		env: z.record(envKeySchema, z.string()).default({}),
	})
	.strict();

const runtimeExecutionSchema = z
	.object({
		mode: z.enum(["managed-process", "external"]).default("managed-process"),
		home: z.string().min(1).optional(),
		stateDir: z.string().min(1).optional(),
		workspace: z.string().min(1).optional(),
		controlCommand: runtimeExecutionCommandSchema.optional(),
		versionCommand: runtimeExecutionCommandSchema.optional(),
		mcp: runtimeExternalMcpSchema.optional(),
		terminal: runtimeTerminalSchema.optional(),
	})
	.strict();

const runtimeImageSchema = z
	.object({
		ref: z.string().min(1).optional(),
		repository: z.string().min(1).optional(),
		tag: z.string().min(1).optional(),
		digest: z.string().min(1).optional(),
		pullPolicy: z.enum(["IfNotPresent", "Always", "Never"]).optional(),
	})
	.strict();

const runtimeVersionSchema = z
	.object({
		desired: z.string().min(1).optional(),
		observed: z.string().min(1).optional(),
		observedAt: z.string().min(1).optional(),
		upgradeAvailable: z.boolean().optional(),
		upgradePolicy: z.enum(["pinned", "track-channel", "manual"]).optional(),
	})
	.strict();

const runtimeSchema = z
	.object({
		type: runtimeTypeSchema,
		enabled: z.boolean(),
		displayName: z.string().min(1).optional(),
		environmentId: z.string().min(1).optional(),
		image: runtimeImageSchema.optional(),
		version: runtimeVersionSchema.optional(),
		updateChannel: z.string().min(1).optional(),
		execution: runtimeExecutionSchema.optional(),
		install: installSchema.optional(),
		run: runtimeRunSettingsSchema.optional(),
		services: z.record(runtimeServiceNameSchema, runtimeRunSettingsSchema).default({}),
	})
	.strict();

const runtimeTargetSchema = runtimeSchema;

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
		agentType: runtimeTypeSchema,
		agentId: runtimeTargetIdSchema,
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
const httpHeaderNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "must be a valid HTTP header name");

export const runtimeBridgeSurfaceSchema = z
	.object({
		name: runtimeBridgeSurfaceNameSchema,
		kind: z.enum(["control-ui"]),
		listenHost: z.string().min(1).optional(),
		listenPort: tcpPortSchema,
		upstreamHost: z.string().min(1).default("127.0.0.1"),
		upstreamPort: tcpPortSchema,
		upstreamHeaders: z.record(httpHeaderNameSchema, z.string()).default({}),
		upstreamHeaderEnv: z.record(httpHeaderNameSchema, envKeySchema).default({}),
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
	runtimes: z.record(runtimeNameSchema, runtimeSchema).default({}),
	bridge: runtimeBridgeSchema.optional(),
	projection: runtimeProjectionSchema.optional(),
	mitmProfiles: mitmProfileInputBundleSchema.optional(),
	liveSync: liveSyncSchema.optional(),
	runtimeTargets: z.record(runtimeTargetIdSchema, runtimeTargetSchema).default({}),
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
		type: runtimeTypeSchema,
		enabled: z.boolean(),
		displayName: z.string().min(1).optional(),
		environmentId: z.string().min(1).optional(),
		image: runtimeImageSchema.optional(),
		version: runtimeVersionSchema.optional(),
		install: hostedRuntimeInstallSchema.optional(),
		run: runtimeRunSettingsSchema.optional(),
		services: z.record(runtimeServiceNameSchema, runtimeRunSettingsSchema).default({}),
		paths: z
			.object({
				home: z.string().min(1).optional(),
				stateDir: z.string().min(1).optional(),
				workspace: z.string().min(1).optional(),
			})
			.passthrough()
			.optional(),
		execution: runtimeExecutionSchema.optional(),
	})
	.passthrough();

const hostedRuntimeTargetEntrySchema = hostedRuntimeEntrySchema;

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
		runtimes: z.record(runtimeNameSchema, hostedRuntimeEntrySchema).default({}),
		runtimeTargets: z.record(runtimeTargetIdSchema, hostedRuntimeTargetEntrySchema).default({}),
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
export type RuntimeExecution = z.output<typeof runtimeExecutionSchema>;
export type RuntimeExecutionCommand = z.output<typeof runtimeExecutionCommandSchema>;
export type HostedRuntimeManifest = z.infer<typeof hostedRuntimeManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;
export type RuntimeType = z.infer<typeof runtimeTypeSchema>;
export type RuntimeBridgeSurfaceInput = z.input<typeof runtimeBridgeSurfaceSchema>;
export type RuntimeBridgeSurfaceSpec = z.output<typeof runtimeBridgeSurfaceSchema>;
