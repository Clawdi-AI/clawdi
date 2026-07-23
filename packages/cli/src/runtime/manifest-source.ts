import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
	runtimeContentSha256,
} from "./applied-state";
import {
	ensureRuntimeAuthTokenFile,
	readRuntimeAuthToken,
	runtimeAuthTokenFileLabel,
} from "./auth-token";
import { hostedManifestEgressProfiles } from "./hosted-egress-profiles";
import {
	type HostedRuntimeManifest,
	hostedCliPayloadPolicySchema,
	hostedFixtureCliPayloadPolicySchema,
	hostedRuntimeBundleV2ManifestSchema,
	hostedRuntimeManifestFixtureResponseSchema,
	hostedRuntimeManifestResponseSchema,
	manifestSchema,
	OFFICIAL_INSTALL_ARGS,
	OFFICIAL_INSTALL_URLS,
	RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
	type RuntimeManifest,
} from "./manifest-contract";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { isSupportedRuntimeName, type RuntimeRunSettings } from "./run-config";
import { canonicalSecretRefName, envSecretRefName, normalizeSecretValues } from "./secret-values";

export interface RuntimeManifestLoad {
	manifest: RuntimeManifest;
	source: "fixture-file" | "remote-datasource" | "last-good-cache";
	sourcePath: string;
	offline: boolean;
	// Values supplied by the manifest datasource. Keep this deploy-surface map provider-only.
	secretValues?: Record<string, string>;
	channelBindings?: RuntimeBundleChannelBinding[];
	sourceRevision?: string;
	// Original datasource manifest before local runtime projections are applied.
	sourceManifest?: RuntimeManifest;
	etag?: string;
}

export const HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json";

export interface RuntimeBundleChannelBinding {
	provider: "telegram" | "discord";
	accountKey: string;
	agentTokenSecretRef: string;
	placeholderTokenSecretRef: string;
}

const runtimeBundleChannelBindingSchema = z
	.object({
		provider: z.enum(["telegram", "discord"]),
		accountKey: z.string().min(1),
		agentTokenSecretRef: z.string().min(1),
		placeholderTokenSecretRef: z.string().min(1),
	})
	.strict();

const hostedRuntimeBundleV2Schema = z
	.object({
		schemaVersion: z.literal("clawdi.hosted-runtime.bundle.v2"),
		sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
		manifest: hostedRuntimeBundleV2ManifestSchema,
		channelBindings: z.array(runtimeBundleChannelBindingSchema),
		secretValues: z.record(z.string(), z.string()),
	})
	.strict()
	.superRefine((bundle, ctx) => {
		const runtime = bundle.manifest.runtimes[bundle.manifest.runtime];
		if (runtime?.providerMode !== "unmanaged") return;
		const codexSecretRef = canonicalSecretRefName(
			bundle.manifest.terminalTooling?.codex.provider.apiKeySecretRef,
		);
		for (const rawSecretRef of Object.keys(bundle.secretValues)) {
			const secretRef = canonicalSecretRefName(rawSecretRef);
			if (!secretRef?.startsWith("provider.") || secretRef === codexSecretRef) continue;
			ctx.addIssue({
				code: "custom",
				message: "unmanaged provider mode must not include provider secret values",
				path: ["secretValues", rawSecretRef],
			});
		}
	});

export function normalizeHostedRuntimeBundleV2(value: unknown): RuntimeManifestLoad {
	const bundle = hostedRuntimeBundleV2Schema.parse(value);
	return {
		manifest: markHostedRuntimeBundleV2(hostedManifestToRuntimeManifest(bundle.manifest)),
		source: "remote-datasource",
		sourcePath: "https://fixture.invalid/v1/runtime/manifest",
		offline: false,
		secretValues: normalizeSecretValues(bundle.secretValues),
		channelBindings: bundle.channelBindings,
		sourceRevision: bundle.sourceRevision,
	};
}

function markHostedRuntimeBundleV2(manifest: RuntimeManifest): RuntimeManifest {
	return {
		...manifest,
		projection: {
			...(manifest.projection ?? {}),
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
		},
	};
}

export interface RuntimeManifestNotModified {
	source: "remote-datasource";
	sourcePath: string;
	notModified: true;
	etag?: string;
}

export interface RuntimeManifestFailure {
	mode: "repair" | "manifest-rejected";
	stage: "detect" | "local" | "network" | "auth";
	errors: string[];
	rejectedGeneration?: number | null;
	activeGeneration?: number | null;
}

export interface RuntimeChannelAgentLink {
	id: string;
	account_id: string;
	agent_id: string;
	status: string;
	agent_token: string | null;
}

export interface RuntimeChannelCredential {
	id: string;
	account_id: string;
	agent_link_id: string;
	agent_id: string;
	provider: string;
	kind: string;
	created_at?: string;
	jid?: string | null;
	identity_pub_key_hex?: string | null;
	material?: unknown;
}

export interface RuntimeChannelAccount {
	id: string;
	provider: "telegram" | "discord" | "whatsapp";
	name: string;
	status: string;
	visibility: "private" | "public";
	runtime_links: RuntimeChannelAgentLink[];
	runtime_credentials: RuntimeChannelCredential[];
}

export interface RuntimeChannelsLoad {
	channels: RuntimeChannelAccount[];
	source: "remote-datasource";
	sourcePath: string;
	etag?: string;
}

interface ExistingManifestState {
	instanceId?: string;
	generation?: number;
}

const legacyRuntimeSourceAuthSchema = z
	.object({
		type: z.literal("bearer-env"),
		env: z.string().min(1).default("CLAWDI_AUTH_TOKEN"),
	})
	.strict();

const runtimeSourceSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeSource.v1"),
		type: z.literal("http"),
		url: z.string().url(),
		auth: legacyRuntimeSourceAuthSchema.optional(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.strict()
	.transform(({ auth: _auth, ...source }) => source);

type RuntimeSource = z.infer<typeof runtimeSourceSchema>;

class RuntimeAuthError extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(
			`runtime manifest authentication failed: HTTP ${status}${
				detail ? ` ${detail.slice(0, 200)}` : ""
			}`,
		);
	}
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function zodErrors(error: z.ZodError): string[] {
	return error.issues.map((issue) => {
		const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
		return `${path}${issue.message}`;
	});
}

function parseManifest(value: unknown): RuntimeManifest {
	return manifestSchema.parse(value);
}

export function normalizeManifestPayload(value: unknown): {
	manifest: RuntimeManifest;
	secretValues?: Record<string, string>;
} {
	const internal = manifestSchema.safeParse(value);
	if (internal.success) return { manifest: internal.data };

	const hostedResponse = hostedRuntimeManifestResponseSchema.safeParse(value);
	if (hostedResponse.success) {
		return {
			manifest: hostedManifestToRuntimeManifest(hostedResponse.data.manifest),
			secretValues: normalizeSecretValues(hostedResponse.data.secretValues),
		};
	}
	if (looksLikeHostedManifestResponse(value)) {
		throw hostedResponse.error;
	}

	throw internal.error;
}

function normalizeRemoteManifestPayload(
	value: unknown,
	paths: RuntimePaths,
): {
	manifest: RuntimeManifest;
	secretValues?: Record<string, string>;
	channelBindings?: RuntimeBundleChannelBinding[];
	sourceRevision?: string;
} {
	if (paths.mode !== "hosted") return normalizeManifestPayload(value);
	const hostedResponse = hostedRuntimeBundleV2Schema.parse(value);
	return {
		manifest: markHostedRuntimeBundleV2(hostedManifestToRuntimeManifest(hostedResponse.manifest)),
		secretValues: normalizeSecretValues(hostedResponse.secretValues),
		channelBindings: hostedResponse.channelBindings,
		sourceRevision: hostedResponse.sourceRevision,
	};
}

function normalizeManifestFixturePayload(
	value: unknown,
	paths: RuntimePaths,
): {
	manifest: RuntimeManifest;
	secretValues?: Record<string, string>;
} {
	if (paths.mode === "hosted") {
		const hostedResponse = hostedRuntimeManifestFixtureResponseSchema.parse(value);
		return {
			manifest: hostedManifestToRuntimeManifest(hostedResponse.manifest),
			secretValues: normalizeSecretValues(hostedResponse.secretValues),
		};
	}
	const internal = manifestSchema.safeParse(value);
	if (internal.success) return { manifest: internal.data };

	const hostedResponse = hostedRuntimeManifestFixtureResponseSchema.safeParse(value);
	if (hostedResponse.success) {
		return {
			manifest: hostedManifestToRuntimeManifest(hostedResponse.data.manifest),
			secretValues: normalizeSecretValues(hostedResponse.data.secretValues),
		};
	}
	if (looksLikeHostedManifestResponse(value)) {
		throw hostedResponse.error;
	}

	throw internal.error;
}

function looksLikeHostedManifestResponse(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = Reflect.get(value, "manifest");
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
	const schemaVersion = Reflect.get(manifest, "schemaVersion");
	return schemaVersion === "clawdi.hosted-runtime.manifest.v1";
}

function rawGeneration(value: unknown): number | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const manifestValue = record.manifest;
	const generation =
		typeof manifestValue === "object" && manifestValue !== null && !Array.isArray(manifestValue)
			? (manifestValue as Record<string, unknown>).generation
			: record.generation;
	return typeof generation === "number" && Number.isInteger(generation) ? generation : null;
}

function runtimeCredential(paths: RuntimePaths): string | null {
	ensureRuntimeAuthTokenFile(paths);
	return readRuntimeAuthToken(paths);
}

function resolveRuntimeSource(paths: RuntimePaths): RuntimeSource {
	const explicit = process.env.CLAWDI_RUNTIME_MANIFEST_URL?.trim();
	if (explicit) {
		let url: URL;
		try {
			url = new URL(explicit);
		} catch {
			throw new Error("invalid CLAWDI_RUNTIME_MANIFEST_URL: expected an absolute URL");
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") {
			throw new Error("invalid CLAWDI_RUNTIME_MANIFEST_URL: protocol must be http or https");
		}
		if (url.username || url.password || url.hash) {
			throw new Error(
				"invalid CLAWDI_RUNTIME_MANIFEST_URL: credentials and fragments are forbidden",
			);
		}
		if (paths.mode === "hosted" && !url.pathname.endsWith("/v1/runtime/manifest")) {
			throw new Error(
				"invalid CLAWDI_RUNTIME_MANIFEST_URL: hosted manifest path must end with /v1/runtime/manifest",
			);
		}
		return {
			schemaVersion: "clawdi.runtimeSource.v1",
			type: "http",
			url: explicit,
		};
	}
	if (paths.mode === "hosted") {
		throw new Error("missing CLAWDI_RUNTIME_MANIFEST_URL");
	}
	return readRuntimeSource(paths);
}

function readRuntimeSource(paths: RuntimePaths): RuntimeSource {
	if (!existsSync(paths.runtimeSource)) {
		throw new Error(`runtime source config does not exist: ${paths.runtimeSource}`);
	}
	const parsed = runtimeSourceSchema.safeParse(readJsonFile(paths.runtimeSource));
	if (!parsed.success) {
		throw new Error(
			`invalid runtime source config at ${paths.runtimeSource}: ${zodErrors(parsed.error).join("; ")}`,
		);
	}
	return parsed.data;
}

async function fetchRuntimeManifestPayload(
	paths: RuntimePaths,
	opts: { ifNoneMatch?: string } = {},
): Promise<
	| {
			url: string;
			raw: unknown;
			etag?: string;
	  }
	| {
			url: string;
			notModified: true;
			etag?: string;
	  }
> {
	const source = resolveRuntimeSource(paths);
	const token = runtimeCredential(paths);
	if (!token) {
		throw new Error(`missing ${runtimeAuthTokenFileLabel(paths)}`);
	}
	const url = source.url;
	const timeoutMs =
		Number.parseInt(process.env.CLAWDI_RUNTIME_MANIFEST_TIMEOUT_MS ?? "", 10) ||
		source.timeoutMs ||
		15000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: paths.mode === "hosted" ? HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE : "application/json",
				authorization: `Bearer ${token}`,
				...(opts.ifNoneMatch ? { "if-none-match": opts.ifNoneMatch } : {}),
			},
			signal: controller.signal,
		});
		const etag = response.headers.get("etag") ?? undefined;
		if (response.status === 304) {
			return { url, notModified: true, etag };
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			if (response.status === 401 || response.status === 403) {
				throw new RuntimeAuthError(response.status, detail);
			}
			throw new Error(
				`runtime manifest request failed: HTTP ${response.status}${
					detail ? ` ${detail.slice(0, 200)}` : ""
				}`,
			);
		}
		if (paths.mode === "hosted") {
			const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
			if (contentType !== HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE) {
				throw new Error(
					`runtime manifest response content-type must be ${HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE}, received ${contentType ?? "missing"}`,
				);
			}
			if (!etag) throw new Error("runtime bundle response is missing its strong ETag");
		}
		return { url, raw: await response.json(), etag };
	} finally {
		clearTimeout(timer);
	}
}

export async function loadRemoteRuntimeManifest(
	paths: RuntimePaths,
	opts: { ifNoneMatch?: string } = {},
): Promise<RuntimeManifestLoad | RuntimeManifestFailure | RuntimeManifestNotModified> {
	let fetched: Awaited<ReturnType<typeof fetchRuntimeManifestPayload>>;
	try {
		fetched = await fetchRuntimeManifestPayload(paths, opts);
	} catch (error) {
		return {
			mode: "repair",
			stage: runtimeFetchFailureStage(error),
			errors: [
				`could not fetch runtime manifest: ${
					error instanceof Error ? error.message : String(error)
				}`,
			],
		};
	}
	if ("notModified" in fetched) {
		return {
			source: "remote-datasource",
			sourcePath: fetched.url,
			notModified: true,
			etag: fetched.etag ?? opts.ifNoneMatch,
		};
	}

	let normalized: {
		manifest: RuntimeManifest;
		secretValues?: Record<string, string>;
		channelBindings?: RuntimeBundleChannelBinding[];
		sourceRevision?: string;
	};
	try {
		normalized = normalizeRemoteManifestPayload(fetched.raw, paths);
	} catch (error) {
		return {
			mode: "manifest-rejected",
			stage: "network",
			errors: error instanceof z.ZodError ? zodErrors(error) : [String(error)],
			rejectedGeneration: rawGeneration(fetched.raw),
			activeGeneration: loadExistingState(paths).generation ?? null,
		};
	}
	const loaded = validateLoadedManifest(normalized, paths, "remote-datasource", fetched.url);
	if ("manifest" in loaded) {
		return { ...loaded, etag: fetched.etag };
	}
	return loaded;
}

function runtimeFetchFailureStage(error: unknown): "network" | "auth" {
	return error instanceof RuntimeAuthError ? "auth" : "network";
}

export function hostedManifestToRuntimeManifest(hosted: HostedRuntimeManifest): RuntimeManifest {
	const paths = getRuntimePaths({ mode: "hosted" });
	const workspaceRoot = paths.workspaceRoot;
	const selectedRuntime = hosted.runtime;
	const runtime = hosted.runtimes[selectedRuntime];
	return {
		schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
		deploymentId: hosted.deploymentId,
		environmentId: hosted.environmentId,
		instanceId: hosted.instanceId,
		generation: hosted.generation,
		minimumCliVersion: hosted.minimumCliVersion,
		issuedAt: hosted.issuedAt,
		expiresAt: hosted.expiresAt,
		locale: hosted.locale,
		workspaceRoot,
		runtime: selectedRuntime,
		controlPlane: {
			apiUrl: hosted.controlPlane.cloudApiUrl,
		},
		clawdiCli: { ...hosted.clawdiCli },
		egressEngine: hosted.egressEngine,
		runtimes: {
			[selectedRuntime]: {
				enabled: runtime.enabled,
				providerMode: runtime.providerMode,
				install: {
					authority: "official" as const,
					method: "official-installer" as const,
					url: OFFICIAL_INSTALL_URLS[selectedRuntime],
					home: paths.userHome,
					args: OFFICIAL_INSTALL_ARGS[selectedRuntime],
				},
				run: hostedRuntimeRunSettings(runtime.run, workspaceRoot),
				services: Object.fromEntries(
					Object.entries(runtime.services ?? {}).map(([service, run]) => [
						service,
						hostedRuntimeServiceRunSettings(run, workspaceRoot),
					]),
				),
				...hostedRuntimeProviderBinding(runtime),
			},
		},
		openclawGatewayAuth: hosted.system.openclawGatewayAuth,
		hermesDashboardAuth: hosted.system.hermesDashboardAuth,
		projection: {
			sourceSchemaVersion: hosted.schemaVersion,
			sourceBundleVersion: "clawdi.hosted-runtime.bundle.v2",
			system: hosted.system,
			providers: hosted.providers,
			...(hosted.mcp === undefined ? {} : { mcp: hosted.mcp }),
			...(hosted.tools === undefined ? {} : { tools: hosted.tools }),
			...(hosted.terminalTooling === undefined ? {} : { terminalTooling: hosted.terminalTooling }),
		},
		liveSync: hosted.liveSync,
		egressProfiles: hostedManifestEgressProfiles(hosted),
		recovery: {
			cacheManifest: hosted.recovery.cacheManifest,
			allowOfflineBoot: hosted.recovery.allowOfflineBoot,
		},
	};
}

function hostedRuntimeProviderBinding(
	runtime: HostedRuntimeManifest["runtimes"][string],
):
	| { provider_ids: string[]; primary_model: { provider_id: string; model: string } }
	| { provider_ids: [] } {
	if (runtime.providerMode === "unmanaged") return { provider_ids: [] };
	return { provider_ids: runtime.provider_ids, primary_model: runtime.primary_model };
}

function hostedRuntimeRunSettings(
	run: RuntimeRunSettings | undefined,
	runtimeWorkspace: string,
): RuntimeRunSettings {
	const cwd = run?.cwd ?? runtimeWorkspace;
	const settings: RuntimeRunSettings = {
		env: run?.env ?? {},
		cwd,
		prependPath: run?.prependPath ?? [],
	};
	if (run?.command !== undefined) settings.command = run.command;
	if (run?.args !== undefined) settings.args = run.args;
	if (run?.secretEnv !== undefined) settings.secretEnv = run.secretEnv;
	return settings;
}

function hostedRuntimeServiceRunSettings(
	run: RuntimeRunSettings,
	runtimeWorkspace: string,
): RuntimeRunSettings {
	return hostedRuntimeRunSettings(run, runtimeWorkspace);
}

function loadExistingState(paths: RuntimePaths): ExistingManifestState {
	const appliedState = readRuntimeAppliedState(paths);
	if (!appliedState) return {};
	return {
		instanceId: appliedState.instanceId,
		generation: appliedState.generation,
	};
}

function manifestExpiryError(manifest: RuntimeManifest): string | null {
	if (!manifest.expiresAt) return null;
	const expiresAtMs = Date.parse(manifest.expiresAt);
	if (!Number.isFinite(expiresAtMs)) {
		return `manifest expiresAt is not a valid timestamp: ${manifest.expiresAt}`;
	}
	if (expiresAtMs <= Date.now()) {
		return `manifest expired at ${manifest.expiresAt}`;
	}
	return null;
}

function validateManifestSemantics(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	trustDomain: "generic" | "hosted" | "hosted-fixture" = "generic",
): string[] {
	const errors: string[] = [];
	const expiryError = manifestExpiryError(manifest);
	if (expiryError) errors.push(expiryError);
	if (!isAbsolute(paths.userHome)) errors.push(`runtime HOME must be absolute: ${paths.userHome}`);
	if (manifest.workspaceRoot && !isAbsolute(manifest.workspaceRoot)) {
		errors.push(`runtime workspaceRoot must be absolute: ${manifest.workspaceRoot}`);
	}
	if (trustDomain !== "generic") {
		const cliPolicySchema =
			trustDomain === "hosted-fixture"
				? hostedFixtureCliPayloadPolicySchema
				: hostedCliPayloadPolicySchema;
		const cliPolicy = cliPolicySchema.safeParse(manifest.clawdiCli);
		if (!cliPolicy.success) {
			errors.push(...zodErrors(cliPolicy.error).map((error) => `clawdiCli.${error}`));
		}
	}
	if (manifest.runtime) {
		const runtime = manifest.runtime;
		const runtimeKeys = Object.keys(manifest.runtimes);
		if (!runtimeKeys.includes(runtime)) {
			errors.push(`manifest runtime ${runtime} must have a matching runtimes.${runtime} entry`);
		}
		for (const key of runtimeKeys) {
			if (key !== runtime) {
				errors.push(`single-runtime manifest must not declare runtimes.${key}`);
			}
		}
		if (manifest.runtimes[runtime]?.enabled !== true) {
			errors.push(`manifest runtime ${runtime} must be enabled`);
		}
		const isHostedV2 =
			trustDomain !== "generic" &&
			manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2";
		if (runtime === "openclaw" && isHostedV2) {
			const auth = manifest.openclawGatewayAuth;
			if (!auth) {
				errors.push("OpenClaw v2 native Control UI requires official gateway token authentication");
			}
			if (auth?.activation.enabled !== true) {
				errors.push("OpenClaw native auth activation must be explicitly enabled");
			}
			const system = manifest.projection?.system;
			const origins =
				typeof system === "object" && system !== null && !Array.isArray(system)
					? (system as Record<string, unknown>).openclawControlUiAllowedOrigins
					: null;
			if (!Array.isArray(origins) || origins.length === 0) {
				errors.push("OpenClaw v2 native Control UI requires an explicit public allowed origin");
			}
			const run = manifest.runtimes.openclaw?.run;
			if (
				JSON.stringify(run?.args) !==
				JSON.stringify([
					"gateway",
					"run",
					"--allow-unconfigured",
					"--port",
					"18789",
					"--bind",
					"lan",
					"--force",
				])
			) {
				errors.push("OpenClaw v2 gateway must bind directly to the pod network on port 18789");
			}
			if (run?.secretEnv?.OPENCLAW_GATEWAY_TOKEN !== auth?.tokenRef) {
				errors.push("OpenClaw v2 gateway token must use the declared environment secret reference");
			}
			if (run?.env?.OPENCLAW_GATEWAY_TOKEN !== undefined) {
				errors.push("OpenClaw v2 gateway token must not be embedded in manifest env");
			}
			for (const service of Object.values(manifest.runtimes.openclaw?.services ?? {})) {
				for (const source of ["env", "secretEnv"] as const) {
					for (const envName of Object.keys(service[source] ?? {})) {
						if (envName === "OPENCLAW_GATEWAY_TOKEN") {
							errors.push("OpenClaw v2 gateway token must be scoped to the gateway run secretEnv");
						}
					}
				}
			}
			for (const provider of Object.values(manifest.projection?.providers ?? {})) {
				if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
				const envName = (provider as Record<string, unknown>).runtimeEnvName;
				if (envName === "OPENCLAW_GATEWAY_TOKEN") {
					errors.push("OpenClaw v2 provider environment must not target native auth controls");
				}
			}
		}
		if (runtime === "hermes" && isHostedV2) {
			if (!manifest.hermesDashboardAuth) {
				errors.push("hermes direct dashboard requires official password authentication");
			}
			if (manifest.hermesDashboardAuth?.activation.enabled !== true) {
				errors.push("hermes password authentication must be explicitly enabled");
			}
			if (manifest.openclawGatewayAuth) {
				errors.push("OpenClaw gateway auth is only valid for the OpenClaw runtime");
			}
			if (
				JSON.stringify(manifest.runtimes.hermes?.services.dashboard?.args) !==
				JSON.stringify(["dashboard", "--host", "0.0.0.0", "--port", "9119", "--no-open"])
			) {
				errors.push("hermes dashboard must bind directly to 0.0.0.0:9119");
			}
		}
	}
	for (const [name, runtime] of Object.entries(manifest.runtimes)) {
		if (!runtime.enabled) continue;
		const runCommand = runtime.run?.command?.trim();
		if (!isSupportedRuntimeName(name)) {
			if (runtime.install) {
				errors.push(
					`runtime ${name} install metadata is not supported by this Clawdi CLI; provide run.command or upgrade the CLI`,
				);
			}
			if (!runCommand) {
				errors.push(
					`runtime ${name} is not supported by this Clawdi CLI; provide run.command or upgrade the CLI`,
				);
			}
			continue;
		}
		if (!runtime.install && !runCommand && !isSupportedRuntimeName(name)) {
			errors.push(`runtime ${name} is enabled but missing install metadata`);
			continue;
		}
		if (!runtime.install) continue;
		const expectedUrl = OFFICIAL_INSTALL_URLS[name];
		if (runtime.install.url !== expectedUrl) {
			errors.push(`runtime ${name} must use official installer ${expectedUrl}`);
		}
		if (runtime.install.home !== paths.userHome) {
			errors.push(`runtime ${name} install.home must match runtime HOME ${paths.userHome}`);
		}
		if (!isAbsolute(runtime.install.home)) {
			errors.push(`runtime ${name} install.home must be absolute`);
		}
		if (runtime.install.args.includes("--dir")) {
			errors.push(`runtime ${name} install args must not include --dir`);
		}
		if (runtime.install.args.includes("--prefix")) {
			errors.push(`runtime ${name} install args must not include --prefix`);
		}
	}
	return errors;
}

export function runtimeManifestFixturePath(): string | undefined {
	const value = process.env.CLAWDI_RUNTIME_MANIFEST_PATH?.trim();
	return value ? value : undefined;
}

export async function loadRuntimeManifest(
	paths: RuntimePaths,
	opts: { manifestPath?: string } = {},
): Promise<RuntimeManifestLoad | RuntimeManifestFailure> {
	const manifestPath = opts.manifestPath ?? runtimeManifestFixturePath();
	if (
		manifestPath &&
		opts.manifestPath === undefined &&
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1"
	) {
		return {
			mode: "repair",
			stage: "local",
			errors: ["CLAWDI_RUNTIME_MANIFEST_PATH requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1"],
		};
	}
	if (!manifestPath) {
		let fetched: { url: string; raw: unknown; etag?: string };
		try {
			const result = await fetchRuntimeManifestPayload(paths);
			if ("notModified" in result) {
				throw new Error("runtime manifest datasource returned 304 without If-None-Match");
			}
			fetched = result;
		} catch (error) {
			const cached = loadLastGoodManifest(paths);
			if ("manifest" in cached) return cached;
			return {
				mode: "repair",
				stage: "network",
				errors: [
					`could not fetch runtime manifest: ${
						error instanceof Error ? error.message : String(error)
					}`,
					...cached.errors,
				],
			};
		}

		let normalized: { manifest: RuntimeManifest; secretValues?: Record<string, string> };
		try {
			normalized = normalizeRemoteManifestPayload(fetched.raw, paths);
		} catch (error) {
			return {
				mode: "manifest-rejected",
				stage: "network",
				errors: error instanceof z.ZodError ? zodErrors(error) : [String(error)],
				rejectedGeneration: rawGeneration(fetched.raw),
				activeGeneration: loadExistingState(paths).generation ?? null,
			};
		}
		const loaded = validateLoadedManifest(normalized, paths, "remote-datasource", fetched.url);
		if ("manifest" in loaded) return { ...loaded, etag: fetched.etag };
		return loaded;
	}

	if (!isAbsolute(manifestPath)) {
		return {
			mode: "repair",
			stage: "local",
			errors: [`CLAWDI_RUNTIME_MANIFEST_PATH must be absolute: ${manifestPath}`],
		};
	}
	if (!existsSync(manifestPath)) {
		return {
			mode: "repair",
			stage: "local",
			errors: [`runtime manifest fixture does not exist: ${manifestPath}`],
		};
	}

	let raw: unknown;
	try {
		raw = readJsonFile(manifestPath);
	} catch (error) {
		return {
			mode: "manifest-rejected",
			stage: "local",
			errors: [
				`could not read runtime manifest fixture at ${manifestPath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			],
			activeGeneration: loadExistingState(paths).generation ?? null,
		};
	}
	let normalized: { manifest: RuntimeManifest; secretValues?: Record<string, string> };
	try {
		normalized = normalizeManifestFixturePayload(raw, paths);
	} catch (error) {
		return {
			mode: "manifest-rejected",
			stage: "local",
			errors: error instanceof z.ZodError ? zodErrors(error) : [String(error)],
			rejectedGeneration: rawGeneration(raw),
			activeGeneration: loadExistingState(paths).generation ?? null,
		};
	}
	const missingSecretRefs = manifestSecretRefsMissingValues(
		normalized.manifest,
		normalized.secretValues,
	);
	if (missingSecretRefs.length > 0) {
		return {
			mode: "manifest-rejected",
			stage: "local",
			errors: [
				`runtime manifest fixture references secretValues (${missingSecretRefs.join(", ")}); refusing fixture without inline secretValues`,
			],
			rejectedGeneration: normalized.manifest.generation,
			activeGeneration: loadExistingState(paths).generation ?? null,
		};
	}

	return validateLoadedManifest(normalized, paths, "fixture-file", manifestPath);
}

function loadLastGoodManifest(paths: RuntimePaths): RuntimeManifestLoad | RuntimeManifestFailure {
	if (!existsSync(paths.manifestLastGood)) {
		return {
			mode: "repair",
			stage: "local",
			errors: ["last-good runtime manifest does not exist"],
		};
	}
	try {
		const manifest = parseManifest(readJsonFile(paths.manifestLastGood));
		if (manifest.recovery.allowOfflineBoot !== true) {
			return {
				mode: "repair",
				stage: "local",
				errors: ["cached manifest does not allow offline boot"],
			};
		}
		const trustDomain = paths.mode === "hosted" ? "hosted" : "generic";
		const semanticErrors = validateManifestSemantics(manifest, paths, trustDomain);
		if (semanticErrors.length > 0) {
			return {
				mode: "repair",
				stage: "local",
				errors: semanticErrors.map((error) => `cached ${error}`),
			};
		}
		const appliedState = readRuntimeAppliedState(paths);
		const cachedApplyIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		const cached = loadCachedSecretValues(paths);
		if ("errors" in cached) return cached;
		if (
			cachedApplyIdentity &&
			(appliedState?.generation !== manifest.generation ||
				appliedState.instanceId !== manifest.instanceId ||
				appliedState.contentIdentity.sha256 !==
					runtimeContentSha256({ manifest, secretValues: cached.secretValues }))
		) {
			return {
				mode: "repair",
				stage: "local",
				errors: [
					"cached manifest does not match the durable strict-v2 apply identity; refusing offline boot",
				],
				activeGeneration: appliedState?.generation ?? null,
			};
		}
		const secretRefs = manifestSecretRefs(manifest);
		if (secretRefs.length > 0) {
			const missingSecretRefs = manifestSecretRefsMissingValues(manifest, cached.secretValues);
			if (missingSecretRefs.length === 0) {
				return {
					manifest,
					source: "last-good-cache",
					sourcePath: paths.manifestLastGood,
					offline: true,
					secretValues: cached.secretValues,
				};
			}
			return {
				mode: "repair",
				stage: "local",
				errors: [
					`cached manifest references secretValues (${missingSecretRefs.join(", ")}); refusing offline boot because cached secret values are missing`,
				],
			};
		}
		return {
			manifest,
			source: "last-good-cache",
			sourcePath: paths.manifestLastGood,
			offline: true,
		};
	} catch (error) {
		return {
			mode: "repair",
			stage: "local",
			errors: [
				`could not read last-good runtime manifest at ${paths.manifestLastGood}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			],
		};
	}
}

function loadCachedSecretValues(
	paths: RuntimePaths,
): { secretValues: Record<string, string> } | RuntimeManifestFailure {
	if (!existsSync(paths.managedSecretCacheFile)) return { secretValues: {} };
	try {
		const raw = readJsonFile(paths.managedSecretCacheFile);
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("cached secret values must be a JSON object");
		}
		const secretValues: Record<string, string> = {};
		for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value !== "string") {
				throw new Error(`cached secret value for ${ref} must be a string`);
			}
			secretValues[ref] = value;
		}
		return { secretValues: normalizeSecretValues(secretValues) };
	} catch (error) {
		return {
			mode: "repair",
			stage: "local",
			errors: [
				`could not read cached runtime secret values at ${paths.managedSecretCacheFile}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			],
		};
	}
}

function manifestSecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	collectSecretRefs(manifest, refs);
	return [...refs].sort();
}

function manifestSecretRefsMissingValues(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): string[] {
	const normalizedValues = normalizeSecretValues(secretValues ?? {});
	return manifestSecretRefs(manifest).filter((ref) => {
		const envName = envSecretRefName(ref);
		if (envName) return !process.env[envName]?.trim();
		return normalizedValues[ref] === undefined;
	});
}

function collectSecretRefs(value: unknown, refs: Set<string>): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectSecretRefs(item, refs);
		return;
	}
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string" && (key === "secretRef" || key.endsWith("SecretRef"))) {
			refs.add(entry);
		}
		if (key === "secretEnv" && entry && typeof entry === "object" && !Array.isArray(entry)) {
			for (const ref of Object.values(entry as Record<string, unknown>)) {
				if (typeof ref === "string") refs.add(ref);
			}
		}
		collectSecretRefs(entry, refs);
	}
}

function validateLoadedManifest(
	normalized: {
		manifest: RuntimeManifest;
		secretValues?: Record<string, string>;
		channelBindings?: RuntimeBundleChannelBinding[];
		sourceRevision?: string;
	},
	paths: RuntimePaths,
	source: RuntimeManifestLoad["source"],
	sourcePath: string,
): RuntimeManifestLoad | RuntimeManifestFailure {
	const existing = loadExistingState(paths);
	const manifest = normalized.manifest;
	const trustDomain =
		paths.mode === "hosted" ? (source === "fixture-file" ? "hosted-fixture" : "hosted") : "generic";
	const semanticErrors = validateManifestSemantics(manifest, paths, trustDomain);
	if (existing.instanceId && existing.instanceId !== manifest.instanceId) {
		semanticErrors.push(
			`manifest instanceId ${manifest.instanceId} does not match applied instanceId ${existing.instanceId}`,
		);
	}
	if (semanticErrors.length > 0) {
		return {
			mode: "manifest-rejected",
			stage: source === "remote-datasource" ? "network" : "local",
			errors: semanticErrors,
			rejectedGeneration: manifest.generation,
			activeGeneration: existing.generation ?? null,
		};
	}

	return {
		manifest,
		source,
		sourcePath,
		offline: false,
		secretValues: normalized.secretValues,
		channelBindings: normalized.channelBindings,
		sourceRevision: normalized.sourceRevision,
	};
}
