import { z } from "zod";
import { isValidSemver } from "../lib/semver";
import { egressProfileInputBundleSchema } from "./egress-profiles";
import {
	runtimeNameSchema,
	runtimeRunSettingsSchema,
	runtimeServiceNameSchema,
} from "./run-config";
import { canonicalSecretRefName } from "./secret-values";

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

export const HOSTED_LOCALE_LANGUAGES = [
	"en",
	"zh-CN",
	"zh-TW",
	"ja",
	"ko",
	"es",
	"fr",
	"de",
	"pt",
] as const;

function isValidIanaTimezone(value: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}

export const runtimeLocaleSchema = z
	.object({
		language: z.enum(HOSTED_LOCALE_LANGUAGES),
		timezone: z.string().min(1).refine(isValidIanaTimezone, "must be a valid IANA timezone"),
	})
	.strict();

const installSchema = z.object({
	authority: z.literal("official"),
	method: z.literal("official-installer"),
	url: z.string().url(),
	home: z.string().min(1),
	args: z.array(z.string()).default([]),
});

const runtimeSchema = z.object({
	enabled: z.boolean(),
	providerMode: z.enum(["configured", "unmanaged"]).optional(),
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

const HOSTED_BOOTSTRAP_PACKAGE_ROOT = "/usr/local/share/clawdi/bootstrap/";

function isHostedExactCliPackageSpec(value: string): boolean {
	const npmVersion = /^clawdi@(.+)$/.exec(value)?.[1];
	return npmVersion !== undefined && isHostedExactSemver(npmVersion);
}

function isHostedExactSemver(value: string): boolean {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
			value,
		);
	if (!match) return false;
	const prerelease = match[4];
	if (!prerelease) return true;
	return prerelease
		.split(".")
		.every((identifier) => !/^\d+$/.test(identifier) || /^(0|[1-9]\d*)$/.test(identifier));
}

function isHostedFixtureCliPackageSpec(value: string): boolean {
	if (isHostedExactCliPackageSpec(value)) return true;
	if (!value.startsWith(HOSTED_BOOTSTRAP_PACKAGE_ROOT)) return false;
	const basename = value.slice(HOSTED_BOOTSTRAP_PACKAGE_ROOT.length);
	return !basename.includes("..") && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(basename);
}

export const hostedCliPackageSpecSchema = z
	.string()
	.max(200)
	.refine(isHostedExactCliPackageSpec, "must be clawdi@<exact-semver>");

export const hostedFixtureCliPackageSpecSchema = z
	.string()
	.max(200)
	.refine(
		isHostedFixtureCliPackageSpec,
		"must be clawdi@<exact-semver> or a managed bootstrap tarball",
	);

export const hostedCliPayloadPolicySchema = z
	.object({
		source: z.literal("npm:clawdi"),
		packageSpec: hostedCliPackageSpecSchema,
		registry: z.literal("https://registry.npmjs.org"),
	})
	.strict();

export const hostedFixtureCliPayloadPolicySchema = hostedCliPayloadPolicySchema.safeExtend({
	packageSpec: hostedFixtureCliPackageSpecSchema,
});

const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

export const egressEngineSchema = z.object({
	type: z.literal("mitmproxy"),
	version: z.string().min(1),
	url: z.string().url(),
	sha256: sha256Schema,
});

export type EgressEnginePin = z.infer<typeof egressEngineSchema>;

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
	terminalTooling: z.unknown().optional(),
});

const runtimeDesiredStateShape = {
	deploymentId: z.string().min(1),
	environmentId: z.string().min(1),
	instanceId: z.string().min(1),
	generation: z.number().int().nonnegative(),
	minimumCliVersion: semverSchema.optional(),
	issuedAt: z.string().min(1),
	expiresAt: z.string().min(1).optional(),
	locale: runtimeLocaleSchema.optional(),
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
		cloudApiUrl: z.string().url(),
	})
	.strict();

const hostedRuntimeRunSettingsSchema = runtimeRunSettingsSchema.strict();
type HostedRuntimeRunSettings = z.infer<typeof hostedRuntimeRunSettingsSchema>;

function validateUnmanagedRunSettings(
	location: string,
	settings: HostedRuntimeRunSettings | undefined,
	ctx: z.RefinementCtx,
): void {
	if (!settings) return;
	const env = settings.env ?? {};
	const secretEnv = settings.secretEnv ?? {};
	for (const envName of ["CLAWDI_MANAGED_OPENAI_API_KEY", "OPENAI_API_KEY"]) {
		if (envName in env || envName in secretEnv) {
			ctx.addIssue({
				code: "custom",
				message: `unmanaged ${location} must not include provider env`,
				path: [location, envName in env ? "env" : "secretEnv", envName],
			});
		}
	}
	for (const [envName, value] of Object.entries(env)) {
		if (value === "clawdi-egress-placeholder") {
			ctx.addIssue({
				code: "custom",
				message: `unmanaged ${location} must not include provider placeholder env`,
				path: [location, "env", envName],
			});
		}
	}
	for (const [source, values] of [
		["env", env],
		["secretEnv", secretEnv],
	] as const) {
		for (const [envName, value] of Object.entries(values)) {
			const secretRef = canonicalSecretRefName(value);
			if (secretRef?.startsWith("provider.")) {
				ctx.addIssue({
					code: "custom",
					message: `unmanaged ${location} must not include provider secret refs`,
					path: [location, source, envName],
				});
			}
		}
	}
}

const urlOriginSchema = z.string().refine((value) => {
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
	} catch {
		return false;
	}
}, "must be an HTTP(S) URL origin");

const hostedRuntimeInstallSchema = z
	.object({
		source: z.literal("official"),
	})
	.strict();

const hostedPrimaryModelSchema = z
	.object({
		provider_id: z.string().min(1),
		model: z.string().min(1),
	})
	.strict();

const hostedProviderIdsSchema = z
	.array(z.string().min(1))
	.min(1)
	.refine((providerIds) => new Set(providerIds).size === providerIds.length, {
		message: "must contain unique provider ids",
	});

const hostedRuntimeEntryBaseShape = {
	enabled: z.boolean(),
	install: hostedRuntimeInstallSchema,
	run: hostedRuntimeRunSettingsSchema.optional(),
	services: z.record(runtimeServiceNameSchema, hostedRuntimeRunSettingsSchema).default({}),
};

const hostedConfiguredRuntimeEntrySchema = z
	.object({
		...hostedRuntimeEntryBaseShape,
		providerMode: z.literal("configured"),
		provider_ids: hostedProviderIdsSchema,
		primary_model: hostedPrimaryModelSchema,
	})
	.strict()
	.superRefine((runtime, ctx) => {
		if (
			runtime.primary_model &&
			!runtime.provider_ids.includes(runtime.primary_model.provider_id)
		) {
			ctx.addIssue({
				code: "custom",
				message: "primary model provider must be included in provider_ids",
				path: ["primary_model", "provider_id"],
			});
		}
	});

const hostedUnmanagedRuntimeEntrySchema = z
	.object({
		...hostedRuntimeEntryBaseShape,
		providerMode: z.literal("unmanaged"),
		provider_ids: z.array(z.string()).length(0),
	})
	.strict()
	.superRefine((runtime, ctx) => {
		validateUnmanagedRunSettings("run", runtime.run, ctx);
		for (const [name, service] of Object.entries(runtime.services)) {
			validateUnmanagedRunSettings(`services.${name}`, service, ctx);
		}
	});

const hostedRuntimeEntrySchema = z.discriminatedUnion("providerMode", [
	hostedConfiguredRuntimeEntrySchema,
	hostedUnmanagedRuntimeEntrySchema,
]);

const hostedProviderCapabilitiesSchema = z
	.object({
		chat: z.boolean().optional(),
		responses: z.boolean().optional(),
		tools: z.boolean().optional(),
		vision: z.boolean().optional(),
		embeddings: z.boolean().optional(),
		image_generation: z.boolean().optional(),
	})
	.strict();

const hostedProviderModelCostSchema = z
	.object({
		input: z.number().nonnegative(),
		output: z.number().nonnegative(),
		cache_read: z.number().nonnegative().optional(),
		cache_write: z.number().nonnegative().optional(),
	})
	.strict();

const hostedProviderModelSchema = z
	.object({
		id: z.string().min(1),
		label: z.string().min(1).optional(),
		alias: z.string().min(1).optional(),
		api_mode: z.string().min(1).optional(),
		input_modalities: z.array(z.string().min(1)).optional(),
		supports_vision: z.boolean().optional(),
		supports_tools: z.boolean().optional(),
		supports_reasoning: z.boolean().optional(),
		context_window: z.number().int().positive().optional(),
		max_input_tokens: z.number().int().positive().optional(),
		max_tokens: z.number().int().positive().optional(),
		cost: hostedProviderModelCostSchema.optional(),
		capabilities: hostedProviderCapabilitiesSchema.optional(),
	})
	.strict();

const hostedProviderAuthSchema = z
	.object({
		type: z.string().min(1),
		tool: z.string().min(1).optional(),
		profile: z.string().min(1).optional(),
		source: z.string().min(1).optional(),
		ref: z.string().min(1).optional(),
	})
	.strict();

const hostedProviderSchema = z
	.object({
		kind: z.literal("openai-compatible"),
		type: z.string().min(1).optional(),
		baseUrl: z.string().url().optional(),
		models: z.array(hostedProviderModelSchema).optional(),
		apiMode: z.string().min(1).optional(),
		managed_by: z.string().min(1).optional(),
		runtimeEnvName: z.string().min(1).optional(),
		apiKeySecretRef: z.string().min(1).nullable().optional(),
		apiKeyRequired: z.boolean().optional(),
		status: z.literal("error").optional(),
		error: z
			.object({
				code: z.string().min(1),
				message: z.string().min(1),
			})
			.strict()
			.optional(),
		auth: hostedProviderAuthSchema.optional(),
	})
	.strict()
	.superRefine((provider, ctx) => {
		const hasErrorStatus = provider.status === "error";
		const hasError = provider.error !== undefined;
		if (hasErrorStatus !== hasError) {
			ctx.addIssue({
				code: "custom",
				message: "provider status:error and error must be supplied together",
				path: hasErrorStatus ? ["error"] : ["status"],
			});
		}

		const isProviderNotFound = hasErrorStatus && provider.error?.code === "provider_not_found";
		const hasNormalProjection = provider.type !== undefined && provider.baseUrl !== undefined;
		if (!isProviderNotFound && !hasNormalProjection) {
			ctx.addIssue({
				code: "custom",
				message: "provider must include type and baseUrl unless it is a provider_not_found error",
				path: [],
			});
		}
		if (provider.managed_by === "clawdi" && provider.runtimeEnvName !== "OPENAI_API_KEY") {
			ctx.addIssue({
				code: "custom",
				message: "Clawdi-managed runtime providers require OPENAI_API_KEY",
				path: ["runtimeEnvName"],
			});
		}
	});

const hostedCodexToolSchema = z
	.object({
		enabled: z.literal(true),
		provider_id: z.string().min(1),
		primary_model: hostedPrimaryModelSchema,
		provider: hostedProviderSchema,
	})
	.strict()
	.superRefine((tool, ctx) => {
		if (tool.primary_model.provider_id !== tool.provider_id) {
			ctx.addIssue({
				code: "custom",
				message: "Codex tool primary model provider must match provider_id",
				path: ["primary_model", "provider_id"],
			});
		}
		if (
			tool.provider.managed_by !== "clawdi" ||
			tool.provider.apiMode !== "openai_responses" ||
			canonicalSecretRefName(tool.provider.apiKeySecretRef) !== "tool.codex.apiKey" ||
			tool.provider.runtimeEnvName !== "OPENAI_API_KEY" ||
			tool.provider.status === "error"
		) {
			ctx.addIssue({
				code: "custom",
				message: "Codex tool requires a healthy Clawdi-managed provider secret reference",
				path: ["provider"],
			});
		}
	});

const hostedTerminalToolingSchema = z
	.object({
		codex: hostedCodexToolSchema,
	})
	.strict();

const hostedRuntimeBridgeSchema = z
	.object({
		surfaces: z.array(runtimeBridgeSurfaceSchema.strict()).default([]),
	})
	.strict();

const hostedLiveSyncAgentSchema = liveSyncAgentSchema
	.extend({
		agentType: z.enum(["openclaw", "hermes", "codex"]),
		environmentId: z
			.string()
			.min(1)
			.max(200)
			.refine((value) => value === value.trim(), "must not contain surrounding whitespace"),
	})
	.strict();

const hostedLiveSyncSchema = z
	.object({
		enabled: z.boolean(),
		agents: z.array(hostedLiveSyncAgentSchema),
	})
	.strict()
	.superRefine((liveSync, ctx) => {
		const identities = liveSync.agents.map(
			(agent) => `${agent.agentType}\u0000${agent.environmentId}`,
		);
		if (new Set(identities).size !== identities.length) {
			ctx.addIssue({
				code: "custom",
				path: ["agents"],
				message: "must not contain duplicate agent identities",
			});
		}
		const hasAgents = liveSync.agents.length > 0;
		if (liveSync.enabled !== hasAgents) {
			ctx.addIssue({
				code: "custom",
				path: ["enabled"],
				message: "must match whether agents are configured",
			});
		}
	});

const hostedRuntimeManifestBaseSchema = z
	.object({
		runtime: hostedRuntimeChoiceSchema,
		deploymentId: z.string().min(1),
		environmentId: z.string().min(1),
		instanceId: z.string().min(1),
		generation: z.number().int().nonnegative(),
		minimumCliVersion: semverSchema,
		issuedAt: z.string().min(1),
		expiresAt: z.string().min(1).optional(),
		locale: runtimeLocaleSchema,
		system: z
			.object({
				openclawControlUiAllowedOrigins: z.array(urlOriginSchema).optional(),
			})
			.strict(),
		controlPlane: hostedControlPlaneSchema,
		egressEngine: egressEngineSchema.strict().optional(),
		runtimes: z.record(runtimeNameSchema, hostedRuntimeEntrySchema),
		bridge: hostedRuntimeBridgeSchema.optional(),
		providers: z.record(z.string().min(1), hostedProviderSchema),
		liveSync: hostedLiveSyncSchema,
		egressProfiles: egressProfileInputBundleSchema.strict().optional(),
		mcp: z.unknown().optional(),
		tools: z.unknown().optional(),
		terminalTooling: hostedTerminalToolingSchema,
		recovery: z
			.object({
				cacheManifest: z.boolean(),
				allowOfflineBoot: z.boolean(),
			})
			.strict(),
	})
	.strict();

type HostedRuntimeManifestBase = z.infer<typeof hostedRuntimeManifestBaseSchema>;

function validateHostedRuntimeManifest(
	manifest: HostedRuntimeManifestBase,
	ctx: z.RefinementCtx,
): void {
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
	const selectedRuntime = manifest.runtimes[manifest.runtime];
	if (selectedRuntime) {
		const providerIds = new Set(selectedRuntime.provider_ids);
		for (const providerId of providerIds) {
			if (!Object.hasOwn(manifest.providers, providerId)) {
				ctx.addIssue({
					code: "custom",
					message: "runtime provider must have a matching provider projection",
					path: ["providers", providerId],
				});
			}
		}
		for (const providerId of Object.keys(manifest.providers)) {
			if (!providerIds.has(providerId)) {
				ctx.addIssue({
					code: "custom",
					message: "provider projection must be selected by the runtime",
					path: ["providers", providerId],
				});
			}
		}
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
}

export const hostedRuntimeManifestSchema = hostedRuntimeManifestBaseSchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
		clawdiCli: hostedCliPayloadPolicySchema,
	})
	.strict()
	.superRefine(validateHostedRuntimeManifest);

export const hostedRuntimeManifestResponseSchema = z
	.object({
		manifest: hostedRuntimeManifestSchema,
		secretValues: z.record(z.string().min(1), z.string()).default({}),
	})
	.strict()
	.superRefine((response, ctx) => {
		const runtime = response.manifest.runtimes[response.manifest.runtime];
		if (runtime?.providerMode !== "unmanaged") return;
		const codexSecretRef = canonicalSecretRefName(
			response.manifest.terminalTooling?.codex.provider.apiKeySecretRef,
		);
		for (const rawSecretRef of Object.keys(response.secretValues)) {
			const secretRef = canonicalSecretRefName(rawSecretRef);
			if (!secretRef?.startsWith("provider.") || secretRef === codexSecretRef) continue;
			ctx.addIssue({
				code: "custom",
				message: "unmanaged provider mode must not include provider secret values",
				path: ["secretValues", rawSecretRef],
			});
		}
	});

const hostedRuntimeManifestFixtureSchema = hostedRuntimeManifestBaseSchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
		clawdiCli: hostedFixtureCliPayloadPolicySchema,
	})
	.strict()
	.superRefine(validateHostedRuntimeManifest);

export const hostedRuntimeManifestFixtureResponseSchema = z
	.object({
		manifest: hostedRuntimeManifestFixtureSchema,
		secretValues: z.record(z.string().min(1), z.string()).default({}),
	})
	.strict();

export type RuntimeManifest = z.output<typeof manifestSchema>;
export type RuntimeInstall = z.infer<typeof installSchema>;
export type HostedRuntimeManifest = z.infer<typeof hostedRuntimeManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;
export type RuntimeBridgeSurfaceInput = z.input<typeof runtimeBridgeSurfaceSchema>;
export type RuntimeBridgeSurfaceSpec = z.output<typeof runtimeBridgeSurfaceSchema>;
