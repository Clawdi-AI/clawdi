import { isIP } from "node:net";
import { join } from "node:path";
import {
	AI_PROVIDER_API_MODES,
	AI_PROVIDER_TYPES,
	MANAGED_AI_PROVIDER_RUNTIME_ENV,
} from "@clawdi/shared";
import { z } from "zod";
import { egressEngineSchema } from "./egress-engine";
import { egressProfileInputBundleSchema } from "./egress-profiles";
import { hostedManifestEgressProfiles } from "./hosted-egress-profiles";
import {
	hostedAgentPluginsDesiredStateSchema,
	hostedMcpDesiredStateSchema,
	hostedSkillsDesiredStateSchema,
} from "./manifest-resources";
import { getRuntimePaths } from "./paths";
import { type RuntimeRunSettings, runtimeNameSchema, runtimeServiceNameSchema } from "./run-config";
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
		(runtime === "openclaw" && exactStringArray(value, LEGACY_HOSTED_OPENCLAW_GATEWAY_RUN_ARGS)) ||
		// SUNSET: remove once every hosted Hermes host has converged on CLI >= 0.14.14 (last-good rewritten canonical).
		(runtime === "hermes" && exactStringArray(value, LEGACY_HOSTED_HERMES_GATEWAY_RUN_ARGS))
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
const trustedProxyIpSchema = z
	.string()
	.max(64)
	.refine((value) => isIP(value) !== 0, "must be an exact IPv4 or IPv6 address");

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

export const hostedCliPackageSpecSchema = z
	.string()
	.max(200)
	.refine(isHostedExactCliPackageSpec, "must be clawdi@<exact-semver>");

export const hostedCliPayloadPolicySchema = z
	.object({
		source: z.literal("npm:clawdi"),
		packageSpec: hostedCliPackageSpecSchema,
		registry: z.literal("https://registry.npmjs.org"),
	})
	.strict();

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
		api_mode: z.enum(AI_PROVIDER_API_MODES).optional(),
		input_modalities: z.array(z.enum(["text", "image", "video", "audio"])).optional(),
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
		type: z.enum(AI_PROVIDER_TYPES).optional(),
		baseUrl: z.string().url().optional(),
		models: z.array(hostedProviderModelSchema).optional(),
		apiMode: z.enum(AI_PROVIDER_API_MODES).optional(),
		managed_by: z.enum(["user", "clawdi"]).optional(),
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

export interface RuntimeInstall {
	authority: "official";
	method: "official-installer";
	url: string;
	home: string;
	args: string[];
}

interface RuntimeEntry {
	enabled: boolean;
	providerMode?: "configured" | "unmanaged";
	updateChannel?: string;
	install?: RuntimeInstall;
	run?: RuntimeRunSettings;
	services: Record<string, RuntimeRunSettings>;
	provider_ids?: string[];
	primary_model?: { provider_id: string; model: string };
}

export interface RuntimeManifest {
	schemaVersion: typeof RUNTIME_DESIRED_STATE_SCHEMA_VERSION;
	deploymentId: string;
	environmentId: string;
	instanceId: string;
	generation: number;
	applyGeneration?: number;
	issuedAt: string;
	expiresAt?: string;
	locale?: z.infer<typeof runtimeLocaleSchema>;
	workspaceRoot?: string;
	runtime?: z.infer<typeof hostedRuntimeChoiceSchema>;
	controlPlane: { apiUrl: string };
	clawdiCli?: {
		source?: string;
		packageSpec?: string;
		registry?: string;
	};
	egressEngine?: z.infer<typeof egressEngineSchema>;
	companions?: z.infer<typeof runtimeCompanionsSchema>;
	runtimes: Record<string, RuntimeEntry>;
	openclawGatewayAuth?: z.infer<typeof openclawGatewayAuthSchema>;
	hermesDashboardAuth?: z.infer<typeof hermesDashboardAuthSchema>;
	projection?: {
		system?: unknown;
		providers?: Record<
			string,
			Partial<z.infer<typeof hostedProviderBaseSchema> & { model: string }>
		>;
		channels?: Record<string, unknown>;
		channelCredentials?: unknown[];
		mcp?: z.infer<typeof hostedMcpDesiredStateSchema>;
		skills?: z.infer<typeof hostedSkillsDesiredStateSchema>;
		agentPlugins?: z.infer<typeof hostedAgentPluginsDesiredStateSchema>;
		tools?: unknown;
		terminalTooling?: z.infer<typeof hostedTerminalToolingSchema>;
	};
	egressProfiles?: z.infer<typeof egressProfileInputBundleSchema>;
	liveSync?: { enabled?: boolean; agents: z.infer<typeof liveSyncAgentSchema>[] };
	recovery: { cacheManifest?: boolean; allowOfflineBoot?: boolean };
}

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
				openclawGatewayTrustedProxies: z
					.array(trustedProxyIpSchema)
					.min(1)
					.max(16)
					.refine((values) => new Set(values).size === values.length, "must not contain duplicates")
					.optional(),
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
export type HostedRuntimeManifest = HostedRuntimeManifestBase;

function validateHostedRuntimeManifest(
	manifest: HostedRuntimeManifestBase,
	ctx: z.RefinementCtx,
): void {
	const addIssue = (message: string, path: string[]): void => {
		ctx.addIssue({ code: "custom", message, path });
	};
	const systemPath = (...path: string[]): string[] => ["system", ...path];
	const runtimePath = (...path: string[]): string[] => ["runtimes", manifest.runtime, ...path];
	const selectedRuntime = manifest.runtimes[manifest.runtime];
	if (!selectedRuntime) {
		addIssue(`runtimes.${manifest.runtime} must be present for selected runtime`, [
			"runtimes",
			manifest.runtime,
		]);
	}
	for (const runtime of Object.keys(manifest.runtimes)) {
		if (runtime !== manifest.runtime) {
			addIssue("hosted runtime manifests must declare exactly one selected runtime", [
				"runtimes",
				runtime,
			]);
		}
	}
	if (selectedRuntime?.enabled !== true) {
		addIssue("selected runtime must be enabled", ["runtimes", manifest.runtime, "enabled"]);
	}
	if (manifest.expiresAt) {
		const expiresAt = Date.parse(manifest.expiresAt);
		if (!Number.isFinite(expiresAt)) {
			addIssue("manifest expiresAt is not a valid timestamp", ["expiresAt"]);
		} else if (expiresAt <= Date.now()) {
			addIssue(`manifest expired at ${manifest.expiresAt}`, ["expiresAt"]);
		}
	}
	if (manifest.runtime === "openclaw") {
		const auth = manifest.system.openclawGatewayAuth;
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
		if (!manifest.system.openclawControlUiAllowedOrigins?.length) {
			addIssue(
				"OpenClaw v2 native Control UI requires an explicit public allowed origin",
				systemPath("openclawControlUiAllowedOrigins"),
			);
		}
		if (!manifest.system.openclawGatewayTrustedProxies?.length) {
			addIssue(
				"OpenClaw v2 reverse proxy requires explicit trusted proxy IPs",
				systemPath("openclawGatewayTrustedProxies"),
			);
		}
		const run = manifest.runtimes.openclaw?.run;
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
		for (const [providerId, provider] of Object.entries(manifest.providers)) {
			if (provider.runtimeEnvName === "OPENCLAW_GATEWAY_TOKEN") {
				addIssue("OpenClaw v2 provider environment must not target native auth controls", [
					"providers",
					providerId,
					"runtimeEnvName",
				]);
			}
		}
	} else {
		if (!manifest.system.hermesDashboardAuth) {
			addIssue(
				"hermes direct dashboard requires official password authentication",
				systemPath("hermesDashboardAuth"),
			);
		}
		if (manifest.system.hermesDashboardAuth?.activation.enabled !== true) {
			addIssue(
				"hermes password authentication must be explicitly enabled",
				systemPath("hermesDashboardAuth", "activation", "enabled"),
			);
		}
		if (manifest.system.openclawGatewayAuth) {
			addIssue(
				"OpenClaw gateway auth is only valid for the OpenClaw runtime",
				systemPath("openclawGatewayAuth"),
			);
		}
		if (manifest.system.openclawGatewayTrustedProxies) {
			addIssue(
				"OpenClaw trusted proxies are only valid for the OpenClaw runtime",
				systemPath("openclawGatewayTrustedProxies"),
			);
		}
		if (!isHostedGatewayRunArgs("hermes", manifest.runtimes.hermes?.run.args)) {
			addIssue(
				"Hermes gateway must use the official gateway run command",
				runtimePath("run", "args"),
			);
		}
		if (!isHostedHermesDashboardArgs(manifest.runtimes.hermes?.services.dashboard?.args)) {
			addIssue(
				"hermes dashboard must bind directly to 0.0.0.0:9119",
				runtimePath("services", "dashboard", "args"),
			);
		}
	}
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

const hostedRuntimeBundleV2ManifestWireSchema = hostedRuntimeManifestBaseSchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.hosted-runtime.manifest.v1"),
		clawdiCli: hostedCliPayloadPolicySchema,
		agentPlugins: hostedAgentPluginsDesiredStateSchema.optional(),
	})
	.strict()
	.superRefine(validateHostedRuntimeManifest);

type HostedRuntimeBundleV2ManifestWire = z.infer<typeof hostedRuntimeBundleV2ManifestWireSchema>;
type HostedRuntimeRunSettings = HostedRuntimeBundleV2ManifestWire["runtimes"][string]["run"];

export const hostedRuntimeBundleV2ManifestSchema =
	hostedRuntimeBundleV2ManifestWireSchema.transform((hosted): RuntimeManifest => {
		const paths = getRuntimePaths({ mode: "hosted" });
		const selectedRuntime = hosted.runtime;
		const runtime = hosted.runtimes[selectedRuntime];
		if (!runtime) throw new Error(`missing selected runtime ${selectedRuntime}`);
		return {
			schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
			deploymentId: hosted.deploymentId,
			environmentId: hosted.environmentId,
			instanceId: hosted.instanceId,
			generation: hosted.generation,
			issuedAt: hosted.issuedAt,
			expiresAt: hosted.expiresAt,
			locale: hosted.locale,
			runtime: selectedRuntime,
			controlPlane: { apiUrl: hosted.controlPlane.cloudApiUrl },
			clawdiCli: { ...hosted.clawdiCli },
			egressEngine: hosted.egressEngine,
			companions: hosted.companions,
			runtimes: {
				[selectedRuntime]: {
					enabled: runtime.enabled,
					providerMode: runtime.providerMode,
					install: {
						authority: "official" as const,
						method: "official-installer" as const,
						url: OFFICIAL_INSTALL_URLS[selectedRuntime],
						home: paths.userHome,
						args: officialInstallArgs(selectedRuntime, paths.userHome),
					},
					run: hostedRuntimeRunSettings(selectedRuntime, runtime.run),
					services: Object.fromEntries(
						Object.entries(runtime.services).map(([service, run]) => [
							service,
							copyHostedRuntimeRunSettings(run),
						]),
					),
					...hostedRuntimeProviderBinding(runtime),
				},
			},
			openclawGatewayAuth: hosted.system.openclawGatewayAuth,
			hermesDashboardAuth: hosted.system.hermesDashboardAuth,
			projection: {
				system: hosted.system,
				providers: hosted.providers,
				...(hosted.mcp === undefined ? {} : { mcp: hosted.mcp }),
				...(hosted.skills === undefined ? {} : { skills: hosted.skills }),
				...(hosted.agentPlugins === undefined ? {} : { agentPlugins: hosted.agentPlugins }),
				...(hosted.tools === undefined ? {} : { tools: hosted.tools }),
				...(hosted.terminalTooling === undefined
					? {}
					: { terminalTooling: hosted.terminalTooling }),
			},
			liveSync: hosted.liveSync,
			egressProfiles: hostedManifestEgressProfiles(hosted),
			recovery: { ...hosted.recovery },
		};
	});

function hostedRuntimeProviderBinding(
	runtime: HostedRuntimeBundleV2ManifestWire["runtimes"][string],
):
	| { provider_ids: string[]; primary_model: { provider_id: string; model: string } }
	| { provider_ids: [] } {
	if (runtime.providerMode === "unmanaged") return { provider_ids: [] };
	return { provider_ids: runtime.provider_ids, primary_model: runtime.primary_model };
}

function hostedRuntimeRunSettings(
	runtime: HostedRuntimeBundleV2ManifestWire["runtime"],
	run: HostedRuntimeRunSettings,
): ReturnType<typeof copyHostedRuntimeRunSettings> {
	const settings = copyHostedRuntimeRunSettings(run);
	if (isHostedGatewayRunArgs(runtime, run.args)) settings.args = ["gateway", "run"];
	return settings;
}

function copyHostedRuntimeRunSettings(run: HostedRuntimeRunSettings): {
	args: string[];
	env: Record<string, string>;
	prependPath: string[];
	secretEnv?: Record<string, string>;
} {
	return {
		args: [...run.args],
		env: {},
		prependPath: [],
		...(run.secretEnv === undefined ? {} : { secretEnv: { ...run.secretEnv } }),
	};
}

export function validateUnmanagedProviderSecretValues(
	response: {
		manifest: Pick<RuntimeManifest, "runtime" | "runtimes" | "projection">;
		secretValues: Readonly<Record<string, string>>;
	},
	ctx: z.RefinementCtx,
): void {
	const selectedRuntime = response.manifest.runtime;
	if (!selectedRuntime) return;
	const runtime = response.manifest.runtimes[selectedRuntime];
	if (runtime?.providerMode !== "unmanaged") return;
	const codexSecretRef = canonicalSecretRefName(
		response.manifest.projection?.terminalTooling?.codex.provider.apiKeySecretRef,
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

export type HostedRuntimeBundleV2Manifest = z.input<typeof hostedRuntimeBundleV2ManifestSchema>;
export type LiveSyncAgent = z.infer<typeof liveSyncAgentSchema>;

export const AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR =
	"Agent Plugin installations require a newer Clawdi runtime capability";

export function hasUnsupportedAgentPluginInstallations(
	manifest: Pick<RuntimeManifest, "projection">,
): boolean {
	return Object.keys(manifest.projection?.agentPlugins?.installations ?? {}).length > 0;
}
