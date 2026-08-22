import { join } from "node:path";
import { MANAGED_AI_PROVIDER_RUNTIME_ENV } from "@clawdi/shared";
import { z } from "zod";
import { egressEngineSchema } from "./egress-engine";
import { egressProfileInputBundleSchema } from "./egress-profiles";
import {
	hostedAgentPluginsDesiredStateSchema,
	hostedMcpDesiredStateSchema,
	hostedSkillsDesiredStateSchema,
} from "./manifest-resources";
import {
	runtimeNameSchema,
	runtimeRunSettingsSchema,
	runtimeServiceNameSchema,
} from "./run-config";
import { canonicalSecretRefName, canonicalSecretRefSchema } from "./secret-values";

export type { EgressEnginePin } from "./egress-engine";
export { egressEngineSchema } from "./egress-engine";

export const RUNTIME_DESIRED_STATE_SCHEMA_VERSION = "clawdi.runtimeDesiredState.v1";
export const HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION = "clawdi.hosted-runtime.bundle.v2";

export const OFFICIAL_INSTALL_URLS: Record<string, string> = {
	openclaw: "https://openclaw.ai/install-cli.sh",
	hermes: "https://hermes-agent.nousresearch.com/install.sh",
};

const HOSTED_GATEWAY_RUN_ARGS = ["gateway", "run"] as const;
const LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS = [
	"gateway",
	"run",
	"--allow-unconfigured",
	"--port",
	"18789",
	"--bind",
	"lan",
	"--force",
] as const;
const LEGACY_HOSTED_HERMES_GATEWAY_RUN_ARGS = ["gateway", "run", "--replace"] as const;
const HOSTED_HERMES_DASHBOARD_ARGS = [
	"dashboard",
	"--host",
	"0.0.0.0",
	"--port",
	"9119",
	"--no-open",
] as const;

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
	return (
		Array.isArray(value) &&
		value.length === expected.length &&
		value.every((entry, index) => entry === expected[index])
	);
}

export function isHostedGatewayRunArgs(runtime: "openclaw" | "hermes", value: unknown): boolean {
	// Keep the previous producer shape readable while the fleet moves to a CLI
	// that leaves command ownership with the official gateway unit.
	return (
		exactStringArray(value, HOSTED_GATEWAY_RUN_ARGS) ||
		exactStringArray(
			value,
			runtime === "openclaw"
				? LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS
				: LEGACY_HOSTED_HERMES_GATEWAY_RUN_ARGS,
		)
	);
}

export function isHostedHermesDashboardArgs(value: unknown): boolean {
	return exactStringArray(value, HOSTED_HERMES_DASHBOARD_ARGS);
}

const OFFICIAL_INSTALL_ARGS: Record<string, string[]> = {
	openclaw: ["--json", "--no-onboard"],
	hermes: ["--skip-setup", "--skip-browser", "--non-interactive"],
};

export function officialInstallArgs(runtime: string, home: string): string[] {
	const args = [...(OFFICIAL_INSTALL_ARGS[runtime] ?? [])];
	return runtime === "openclaw" ? [...args, "--prefix", join(home, ".local")] : args;
}

const hostedRuntimeChoiceSchema = z.enum(["openclaw", "hermes"]);

function cleanHttpsUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
			? url
			: null;
	} catch {
		return null;
	}
}

const hermesDashboardAuthSchema = z
	.object({
		mode: z.literal("password"),
		provider: z.literal("basic"),
		username: z.string().trim().min(1).max(128),
		passwordSecretRef: z.literal("secret://runtime/hermes/dashboard-password"),
		sessionSecretRef: z.literal("secret://runtime/hermes/dashboard-session-secret"),
		sessionTtlSeconds: z.number().int().min(60).max(604_800).default(43_200),
		publicUrl: z.string().url(),
		activation: z
			.object({
				enabled: z.literal(true),
				capability: z.literal("hermes-basic-auth-v1"),
			})
			.strict(),
	})
	.strict()
	.superRefine((auth, ctx) => {
		if (!cleanHttpsUrl(auth.publicUrl)) {
			ctx.addIssue({
				code: "custom",
				message: "must be an HTTPS URL without credentials, query, or fragment",
				path: ["publicUrl"],
			});
		}
	});

const openclawGatewayAuthSchema = z
	.object({
		mode: z.literal("token"),
		tokenRef: z.literal("secret://runtime/openclaw/gateway-token"),
		deviceAuthRequired: z.literal(false),
		activation: z
			.object({
				enabled: z.literal(true),
				capability: z.literal("openclaw-native-auth-v1"),
			})
			.strict(),
	})
	.strict();

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
	provider_ids: z.array(z.string().min(1)).max(1).optional(),
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
export const HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE = `${HOSTED_BOOTSTRAP_PACKAGE_ROOT}clawdi-local.tgz`;

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

export const FILE_BROWSER_PORT = 9120;

const fileBrowserVersionSchema = z
	.string()
	.regex(/^v[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/, "must be a canonical release tag");
const fileBrowserCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);

const fileBrowserAssetSchema = z
	.object({
		url: z.string().url(),
		sha256: sha256Schema,
	})
	.strict();

const FILE_BROWSER_AUDIENCE_PREFIX = "clawdi-files:";

function isCanonicalFileBrowserAssetUrl(
	url: string,
	version: string,
	architecture: string,
): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "github.com" &&
			parsed.port === "" &&
			parsed.username === "" &&
			parsed.password === "" &&
			parsed.search === "" &&
			parsed.hash === "" &&
			parsed.pathname ===
				`/gtsteffaniak/filebrowser/releases/download/${version}/linux-${architecture}-filebrowser`
		);
	} catch {
		return false;
	}
}

const fileBrowserAuthSchema = z
	.object({
		method: z.literal("jwt"),
		algorithm: z.literal("HS256"),
		header: z.literal("X-JWT-Assertion"),
		userIdentifier: z.literal("sub"),
		groupsClaim: z.literal("groups"),
		secret: z
			.string()
			.min(43)
			.max(128)
			.regex(/^[A-Za-z0-9_-]+$/),
		audience: z.string().min(1).max(256),
		subject: z.string().min(1).max(256),
		requiredGroup: z.string().min(1).max(256),
		accessRevision: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()
	.superRefine((auth, ctx) => {
		const deploymentId = auth.audience.startsWith(FILE_BROWSER_AUDIENCE_PREFIX)
			? auth.audience.slice(FILE_BROWSER_AUDIENCE_PREFIX.length)
			: "";
		if (
			!deploymentId ||
			auth.subject !== `deployment:${deploymentId}:owner` ||
			auth.requiredGroup !== `${auth.audience}:${auth.accessRevision}`
		) {
			ctx.addIssue({
				code: "custom",
				message: "Files authentication fields must reference one deployment revision",
			});
		}
	});

export const fileBrowserCompanionSchema = z
	.object({
		version: fileBrowserVersionSchema,
		commit: fileBrowserCommitSchema,
		listen: z.literal("0.0.0.0"),
		port: z.literal(FILE_BROWSER_PORT),
		baseURL: z.literal("/"),
		healthPath: z.literal("/health"),
		sourceRoot: z.literal("/home/clawdi"),
		assets: z
			.object({
				amd64: fileBrowserAssetSchema,
				arm64: fileBrowserAssetSchema,
			})
			.strict(),
		auth: fileBrowserAuthSchema,
	})
	.strict()
	.superRefine((companion, ctx) => {
		for (const architecture of ["amd64", "arm64"] as const) {
			if (
				!isCanonicalFileBrowserAssetUrl(
					companion.assets[architecture].url,
					companion.version,
					architecture,
				)
			) {
				ctx.addIssue({
					code: "custom",
					message: "Files asset URL must match its declared release and architecture",
					path: ["assets", architecture, "url"],
				});
			}
		}
	});

const runtimeCompanionsSchema = z
	.object({
		filebrowser: fileBrowserCompanionSchema.optional(),
	})
	.strict();

const liveSyncAgentSchema = z.object({
	agentType: runtimeNameSchema,
	environmentId: z.string().min(1),
});

const liveSyncSchema = z.object({
	enabled: z.boolean().optional(),
	agents: z.array(liveSyncAgentSchema).default([]),
});

const runtimeProjectionSchema = z.object({
	sourceSchemaVersion: z.string().min(1).optional(),
	sourceBundleVersion: z.literal(HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION).optional(),
	system: z.unknown().nullable().optional(),
	providers: z.record(z.string().min(1), z.unknown()).optional(),
	channels: z.record(z.string().min(1), z.unknown()).optional(),
	channelCredentials: z.array(z.unknown()).optional(),
	aiProviders: z.record(z.string().min(1), z.unknown()).optional(),
	mcp: hostedMcpDesiredStateSchema.optional(),
	skills: hostedSkillsDesiredStateSchema.optional(),
	agentPlugins: hostedAgentPluginsDesiredStateSchema.optional(),
	tools: z.unknown().optional(),
	terminalTooling: z.unknown().optional(),
});

const runtimeDesiredStateShape = {
	deploymentId: z.string().min(1),
	environmentId: z.string().min(1),
	instanceId: z.string().min(1),
	generation: z.number().int().nonnegative(),
	applyGeneration: z.number().int().positive().safe().optional(),
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
	companions: runtimeCompanionsSchema.optional(),
	runtimes: z.record(runtimeNameSchema, runtimeSchema),
	openclawGatewayAuth: openclawGatewayAuthSchema.optional(),
	hermesDashboardAuth: hermesDashboardAuthSchema.optional(),
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

const runtimeManifestSchema = z
	.object({
		schemaVersion: z.literal(RUNTIME_DESIRED_STATE_SCHEMA_VERSION),
		...runtimeDesiredStateShape,
		secrets: z.unknown().optional(),
	})
	.superRefine((manifest, ctx) => {
		if ("secrets" in manifest) addForbiddenFieldIssue(ctx, "secrets");
	})
	.transform(({ secrets: _secrets, ...manifest }) => manifest);

export const manifestSchema = z
	.unknown()
	.superRefine((value, ctx) => {
		if (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			Object.hasOwn(value, "bridge")
		) {
			addForbiddenFieldIssue(ctx, "bridge");
		}
	})
	.pipe(runtimeManifestSchema);

const hostedControlPlaneSchema = z
	.object({
		cloudApiUrl: z.string().url(),
	})
	.strict();

const hostedGatewayRunSettingsSchema = z
	.object({
		args: z.array(z.string()),
		secretEnv: z
			.object({
				OPENCLAW_GATEWAY_TOKEN: z.literal("secret://runtime/openclaw/gateway-token"),
			})
			.strict()
			.optional(),
	})
	.strict();

const hostedServiceRunSettingsSchema = z
	.object({
		args: z.array(z.string()),
	})
	.strict();

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

const hostedProviderIdsSchema = z.array(z.string().min(1)).min(1).max(1);

const hostedRuntimeEntryBaseShape = {
	enabled: z.boolean(),
	install: hostedRuntimeInstallSchema,
	run: hostedGatewayRunSettingsSchema,
	services: z.record(runtimeServiceNameSchema, hostedServiceRunSettingsSchema).default({}),
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
	.strict();

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
		compat: z.record(z.string(), z.unknown()).optional(),
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
		credentialSecretRef: canonicalSecretRefSchema.optional(),
		credentialRevision: z.string().min(1).max(64).optional(),
	})
	.strict()
	.superRefine((auth, ctx) => {
		const hasSecretRef = auth.credentialSecretRef !== undefined;
		const hasRevision = auth.credentialRevision !== undefined;
		if (hasSecretRef !== hasRevision) {
			ctx.addIssue({
				code: "custom",
				message: "OAuth credential secret ref and revision must be supplied together",
				path: [hasSecretRef ? "credentialRevision" : "credentialSecretRef"],
			});
		}
	});

const hostedProviderBaseSchema = z
	.object({
		kind: z.literal("openai-compatible"),
		type: z.string().min(1).optional(),
		baseUrl: z.string().url().optional(),
		models: z.array(hostedProviderModelSchema).optional(),
		apiMode: z.string().min(1).optional(),
		managed_by: z.string().min(1).optional(),
		runtimeEnvName: z.string().min(1).optional(),
		apiKeySecretRef: canonicalSecretRefSchema.nullable().optional(),
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
	.strict();

function validateHostedProvider(
	provider: z.infer<typeof hostedProviderBaseSchema>,
	ctx: z.RefinementCtx,
): void {
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
}

const hostedProviderSchema = hostedProviderBaseSchema.superRefine(validateHostedProvider);

const hostedRuntimeProviderSchema = hostedProviderSchema.superRefine((provider, ctx) => {
	if (
		provider.managed_by === "clawdi" &&
		provider.runtimeEnvName !== MANAGED_AI_PROVIDER_RUNTIME_ENV
	) {
		ctx.addIssue({
			code: "custom",
			message: `Clawdi-managed runtime providers require ${MANAGED_AI_PROVIDER_RUNTIME_ENV}`,
			path: ["runtimeEnvName"],
		});
	}
});

const hostedCodexProviderSchema = hostedProviderBaseSchema
	.omit({ models: true })
	.superRefine(validateHostedProvider);

const hostedCodexToolSchema = z
	.object({
		enabled: z.literal(true),
		provider_id: z.string().min(1),
		primary_model: hostedPrimaryModelSchema,
		provider: hostedCodexProviderSchema,
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
			tool.provider.runtimeEnvName !== MANAGED_AI_PROVIDER_RUNTIME_ENV ||
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
		issuedAt: z.string().min(1),
		expiresAt: z.string().min(1).optional(),
		locale: runtimeLocaleSchema,
		system: z
			.object({
				openclawControlUiAllowedOrigins: z.array(urlOriginSchema).optional(),
				openclawControlUiBasePath: z
					.string()
					.regex(/^\/(?:[^/?#]+(?:\/[^/?#]+)*)?$/)
					.optional(),
				openclawGatewayAuth: openclawGatewayAuthSchema.optional(),
				hermesDashboardAuth: hermesDashboardAuthSchema.optional(),
			})
			.strict(),
		controlPlane: hostedControlPlaneSchema,
		egressEngine: egressEngineSchema.strict().optional(),
		companions: runtimeCompanionsSchema.optional(),
		runtimes: z.record(runtimeNameSchema, hostedRuntimeEntrySchema),
		providers: z.record(z.string().min(1), hostedRuntimeProviderSchema),
		liveSync: hostedLiveSyncSchema,
		egressProfiles: egressProfileInputBundleSchema.strict().optional(),
		mcp: hostedMcpDesiredStateSchema.optional(),
		skills: hostedSkillsDesiredStateSchema.optional(),
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

interface HostedRuntimeSemanticRun {
	args?: readonly string[];
	secretEnv?: Readonly<Record<string, string>>;
}

interface HostedRuntimeSemanticEntry {
	enabled?: boolean;
	run?: HostedRuntimeSemanticRun;
	services?: Readonly<Record<string, HostedRuntimeSemanticRun>>;
}

export interface HostedRuntimeSemanticView {
	hostedV2: boolean;
	runtime: string;
	runtimes: Readonly<Record<string, HostedRuntimeSemanticEntry | undefined>>;
	openclawGatewayAuth?: {
		tokenRef?: string;
		activation: { enabled?: boolean };
	};
	hermesDashboardAuth?: { activation: { enabled?: boolean } };
	openclawControlUiAllowedOrigins?: unknown;
	providers?: Readonly<Record<string, unknown>>;
}

export interface HostedRuntimeSemanticIssue {
	message: string;
	path: string[];
}

export function hostedRuntimeSemanticIssues(
	view: HostedRuntimeSemanticView,
): HostedRuntimeSemanticIssue[] {
	const issues: HostedRuntimeSemanticIssue[] = [];
	const addIssue = (message: string, path: string[]): void => {
		issues.push({ message, path });
	};
	const systemPath = (...path: string[]): string[] => ["system", ...path];
	const runtimePath = (...path: string[]): string[] => ["runtimes", view.runtime, ...path];
	const runtimeKeys = Object.keys(view.runtimes);
	const selectedRuntime = view.runtimes[view.runtime];
	if (!selectedRuntime) {
		addIssue(`runtimes.${view.runtime} must be present for selected runtime`, [
			"runtimes",
			view.runtime,
		]);
	}
	for (const key of runtimeKeys) {
		if (key === view.runtime) continue;
		addIssue("hosted runtime manifests must declare exactly one selected runtime", [
			"runtimes",
			key,
		]);
	}
	if (selectedRuntime?.enabled !== true) {
		addIssue("selected runtime must be enabled", ["runtimes", view.runtime, "enabled"]);
	}
	if (!view.hostedV2) return issues;

	if (view.runtime === "openclaw") {
		const auth = view.openclawGatewayAuth;
		if (!auth) {
			addIssue(
				"OpenClaw v2 native Control UI requires official gateway token authentication",
				systemPath("openclawGatewayAuth"),
			);
		} else if (auth.activation.enabled !== true) {
			addIssue(
				"OpenClaw native auth activation must be explicitly enabled",
				systemPath("openclawGatewayAuth", "activation", "enabled"),
			);
		}
		if (
			!Array.isArray(view.openclawControlUiAllowedOrigins) ||
			view.openclawControlUiAllowedOrigins.length === 0
		) {
			addIssue(
				"OpenClaw v2 native Control UI requires an explicit public allowed origin",
				systemPath("openclawControlUiAllowedOrigins"),
			);
		}
		const run = view.runtimes.openclaw?.run;
		if (!isHostedGatewayRunArgs("openclaw", run?.args)) {
			addIssue(
				"OpenClaw v2 gateway must use the official gateway run command",
				runtimePath("run", "args"),
			);
		}
		if (run?.secretEnv?.OPENCLAW_GATEWAY_TOKEN !== auth?.tokenRef) {
			addIssue(
				"OpenClaw v2 gateway token must use the declared environment secret reference",
				runtimePath("run", "secretEnv", "OPENCLAW_GATEWAY_TOKEN"),
			);
		}
		for (const [providerId, provider] of Object.entries(view.providers ?? {})) {
			if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
			if ((provider as Record<string, unknown>).runtimeEnvName === "OPENCLAW_GATEWAY_TOKEN") {
				addIssue("OpenClaw v2 provider environment must not target native auth controls", [
					"providers",
					providerId,
					"runtimeEnvName",
				]);
			}
		}
	}

	if (view.runtime === "hermes") {
		if (!view.hermesDashboardAuth) {
			addIssue(
				"hermes direct dashboard requires official password authentication",
				systemPath("hermesDashboardAuth"),
			);
		}
		if (view.hermesDashboardAuth?.activation.enabled !== true) {
			addIssue(
				"hermes password authentication must be explicitly enabled",
				systemPath("hermesDashboardAuth", "activation", "enabled"),
			);
		}
		if (view.openclawGatewayAuth) {
			addIssue(
				"OpenClaw gateway auth is only valid for the OpenClaw runtime",
				systemPath("openclawGatewayAuth"),
			);
		}
		if (!isHostedGatewayRunArgs("hermes", view.runtimes.hermes?.run?.args)) {
			addIssue(
				"Hermes gateway must use the official gateway run command",
				runtimePath("run", "args"),
			);
		}
		if (!isHostedHermesDashboardArgs(view.runtimes.hermes?.services?.dashboard?.args)) {
			addIssue(
				"hermes dashboard must bind directly to 0.0.0.0:9119",
				runtimePath("services", "dashboard", "args"),
			);
		}
	}
	return issues;
}

function hostedRuntimeManifestSemanticView(
	manifest: HostedRuntimeManifestBase,
): HostedRuntimeSemanticView {
	return {
		hostedV2: true,
		runtime: manifest.runtime,
		runtimes: manifest.runtimes,
		openclawGatewayAuth: manifest.system.openclawGatewayAuth,
		hermesDashboardAuth: manifest.system.hermesDashboardAuth,
		openclawControlUiAllowedOrigins: manifest.system.openclawControlUiAllowedOrigins,
		providers: manifest.providers,
	};
}

function validateHostedRuntimeManifest(
	manifest: HostedRuntimeManifestBase,
	ctx: z.RefinementCtx,
): void {
	for (const issue of hostedRuntimeSemanticIssues(hostedRuntimeManifestSemanticView(manifest))) {
		ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
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
	if (manifest.runtime === "hermes") {
		const runtime = manifest.runtimes.hermes;
		if (runtime?.run.secretEnv) {
			ctx.addIssue({
				code: "custom",
				message: "Hermes gateway must not declare OpenClaw gateway credentials",
				path: ["runtimes", "hermes", "run", "secretEnv"],
			});
		}
		const serviceNames = Object.keys(runtime?.services ?? {});
		if (serviceNames.length !== 1 || serviceNames[0] !== "dashboard") {
			ctx.addIssue({
				code: "custom",
				message: "Hermes must declare only its official dashboard command",
				path: ["runtimes", "hermes", "services"],
			});
		}
	} else if (manifest.system.hermesDashboardAuth) {
		ctx.addIssue({
			code: "custom",
			message: "Hermes dashboard auth is only valid for the Hermes runtime",
			path: ["system", "hermesDashboardAuth"],
		});
	}
	if (
		manifest.runtime === "openclaw" &&
		Object.keys(manifest.runtimes.openclaw?.services ?? {}).length > 0
	) {
		ctx.addIssue({
			code: "custom",
			message: "OpenClaw hosted runtime must not declare auxiliary services",
			path: ["runtimes", "openclaw", "services"],
		});
	}
}

export const hostedRuntimeManifestSchema = hostedRuntimeManifestBaseSchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
		clawdiCli: hostedCliPayloadPolicySchema,
	})
	.strict()
	.superRefine(validateHostedRuntimeManifest);

export const hostedRuntimeBundleV2ManifestSchema = hostedRuntimeManifestBaseSchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
		clawdiCli: hostedCliPayloadPolicySchema,
		agentPlugins: hostedAgentPluginsDesiredStateSchema.optional(),
	})
	.strict()
	.superRefine(validateHostedRuntimeManifest);

export function validateUnmanagedProviderSecretValues(
	response: {
		manifest: {
			runtime: string;
			runtimes: Readonly<Record<string, { providerMode?: "configured" | "unmanaged" } | undefined>>;
			terminalTooling?: { codex: { provider: { apiKeySecretRef?: string | null } } };
		};
		secretValues: Readonly<Record<string, string>>;
	},
	ctx: z.RefinementCtx,
): void {
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
}

export type RuntimeManifest = z.output<typeof manifestSchema>;
export type RuntimeInstall = z.infer<typeof installSchema>;
export type HostedRuntimeManifest = z.infer<typeof hostedRuntimeManifestSchema>;
export type HostedRuntimeBundleV2Manifest = z.infer<typeof hostedRuntimeBundleV2ManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;

export const AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR =
	"Agent Plugin installations require a newer Clawdi runtime capability";
export const AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR =
	"Agent Plugin reconciliation requires a hosted v2 bundle";

export function hasUnsupportedAgentPluginInstallations(
	manifest: Pick<RuntimeManifest, "projection">,
): boolean {
	return Object.keys(manifest.projection?.agentPlugins?.installations ?? {}).length > 0;
}
