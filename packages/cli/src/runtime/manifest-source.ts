import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	ensureRuntimeAuthTokenFile,
	readRuntimeAuthToken,
	runtimeAuthTokenFileLabel,
} from "./auth-token";
import { hostedManifestMitmProfiles } from "./hosted-mitm-profiles";
import {
	DEFAULT_CLAWDI_CLI_POLICY,
	type HostedRuntimeManifest,
	hostedRuntimeManifestResponseSchema,
	manifestSchema,
	OFFICIAL_INSTALL_ARGS,
	OFFICIAL_INSTALL_URLS,
	RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
	type RuntimeManifest,
} from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import { isSupportedRuntimeName, type RuntimeRunSettings } from "./run-config";
import { envSecretRefName, normalizeSecretValues } from "./secret-values";

export interface RuntimeManifestLoad {
	manifest: RuntimeManifest;
	source: "fixture-file" | "remote-datasource" | "last-good-cache";
	sourcePath: string;
	offline: boolean;
	// Values supplied by the manifest datasource. Keep this deploy-surface map provider-only.
	secretValues?: Record<string, string>;
	// Values synthesized from separate local/runtime datasources, such as /v1/channels.
	localSecretValues?: Record<string, string>;
	// Original datasource manifest before local runtime projections are applied.
	sourceManifest?: RuntimeManifest;
	etag?: string;
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

const RUNTIME_CHANNEL_PROVIDERS = ["telegram", "discord", "whatsapp"] as const;
const runtimeChannelProviderSchema = z.enum(RUNTIME_CHANNEL_PROVIDERS);
type RuntimeChannelProvider = z.infer<typeof runtimeChannelProviderSchema>;

export interface RuntimeChannelAccount {
	id: string;
	provider: RuntimeChannelProvider;
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

export interface RuntimeChannelsNotModified {
	source: "remote-datasource";
	sourcePath: string;
	notModified: true;
	etag?: string;
}

export interface RuntimeChannelsFailure {
	mode: "repair";
	stage: "network" | "auth";
	errors: string[];
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
		readonly resource: "manifest" | "channels",
		readonly status: number,
		detail: string,
	) {
		super(
			`runtime ${resource} authentication failed: HTTP ${status}${
				detail ? ` ${detail.slice(0, 200)}` : ""
			}`,
		);
	}
}

const runtimeChannelAgentLinkSchema = z
	.object({
		id: z.string().min(1),
		account_id: z.string().min(1),
		agent_id: z.string().min(1),
		status: z.string().min(1),
		agent_token: z.string().min(1).nullable().optional(),
	})
	.passthrough()
	.transform((link) => ({
		...link,
		agent_token: link.agent_token ?? null,
	}));

const runtimeChannelCredentialSchema = z
	.object({
		id: z.string().min(1),
		account_id: z.string().min(1),
		agent_link_id: z.string().min(1),
		agent_id: z.string().min(1),
		provider: z.string().min(1),
		kind: z.string().min(1),
		created_at: z.string().min(1).optional(),
		jid: z.string().min(1).nullable().optional(),
		identity_pub_key_hex: z.string().min(1).nullable().optional(),
		material: z.unknown().optional(),
	})
	.passthrough();

const runtimeChannelAccountSchema = z
	.object({
		id: z.string().min(1),
		provider: runtimeChannelProviderSchema,
		name: z.string().min(1),
		status: z.string().min(1),
		visibility: z.enum(["private", "public"]).default("private"),
		runtime_links: z.array(runtimeChannelAgentLinkSchema).default([]),
		runtime_credentials: z.array(runtimeChannelCredentialSchema).default([]),
	})
	.passthrough();

const runtimeChannelsSchema = z.array(z.unknown()).transform((accounts, ctx) => {
	const allowedAccounts: RuntimeChannelAccount[] = [];
	for (const [index, account] of accounts.entries()) {
		const provider = recordValue(account)?.provider;
		if (typeof provider === "string" && !isRuntimeChannelProvider(provider)) {
			continue;
		}
		const parsed = runtimeChannelAccountSchema.safeParse(account);
		if (!parsed.success) {
			for (const issue of parsed.error.issues) {
				ctx.addIssue({ ...issue, path: [index, ...issue.path] });
			}
			continue;
		}
		allowedAccounts.push(parsed.data);
	}
	return allowedAccounts;
});

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function recordValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function isRuntimeChannelProvider(value: string): value is RuntimeChannelProvider {
	return runtimeChannelProviderSchema.safeParse(value).success;
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

function parseManifestSafe(value: unknown): RuntimeManifest | null {
	const result = manifestSchema.safeParse(value);
	return result.success ? result.data : null;
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

function looksLikeHostedManifestResponse(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = (value as Record<string, unknown>).manifest;
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
	return (
		(manifest as Record<string, unknown>).schemaVersion === "clawdi.hosted-runtime.manifest.v1"
	);
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
		return {
			schemaVersion: "clawdi.runtimeSource.v1",
			type: "http",
			url: explicit,
		};
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
				accept: "application/json",
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
				throw new RuntimeAuthError("manifest", response.status, detail);
			}
			throw new Error(
				`runtime manifest request failed: HTTP ${response.status}${
					detail ? ` ${detail.slice(0, 200)}` : ""
				}`,
			);
		}
		return { url, raw: await response.json(), etag };
	} finally {
		clearTimeout(timer);
	}
}

function runtimeChannelsUrl(source: RuntimeSource): string {
	const url = new URL(source.url);
	const environmentId = url.searchParams.get("environment_id");
	const path = url.pathname.replace(/\/+$/, "");
	// Manifest URLs persisted before the /v1 migration still use /api.
	const manifestSuffix = ["/v1/runtime/manifest", "/api/runtime/manifest"].find((suffix) =>
		path.endsWith(suffix),
	);
	if (manifestSuffix) {
		const prefix = path.slice(0, -manifestSuffix.length);
		url.pathname = `${prefix}/v1/channels`;
	} else {
		url.pathname = new URL("v1/channels", url).pathname;
	}
	url.search = "";
	if (environmentId) {
		url.searchParams.set("environment_id", environmentId);
	}
	url.hash = "";
	return url.toString();
}

async function fetchRuntimeChannelsPayload(
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
	const url = runtimeChannelsUrl(source);
	const timeoutMs =
		Number.parseInt(process.env.CLAWDI_RUNTIME_CHANNELS_TIMEOUT_MS ?? "", 10) ||
		source.timeoutMs ||
		15000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: "application/json",
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
				throw new RuntimeAuthError("channels", response.status, detail);
			}
			throw new Error(
				`runtime channels request failed: HTTP ${response.status}${
					detail ? ` ${detail.slice(0, 200)}` : ""
				}`,
			);
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

	let normalized: { manifest: RuntimeManifest; secretValues?: Record<string, string> };
	try {
		normalized = normalizeManifestPayload(fetched.raw);
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

export async function loadRemoteRuntimeChannels(
	paths: RuntimePaths,
	opts: { ifNoneMatch?: string } = {},
): Promise<RuntimeChannelsLoad | RuntimeChannelsFailure | RuntimeChannelsNotModified> {
	let fetched: Awaited<ReturnType<typeof fetchRuntimeChannelsPayload>>;
	try {
		fetched = await fetchRuntimeChannelsPayload(paths, opts);
	} catch (error) {
		return {
			mode: "repair",
			stage: runtimeFetchFailureStage(error),
			errors: [
				`could not fetch runtime channels: ${
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
	const parsed = runtimeChannelsSchema.safeParse(fetched.raw);
	if (!parsed.success) {
		return {
			mode: "repair",
			stage: "network",
			errors: zodErrors(parsed.error),
		};
	}
	return {
		channels: parsed.data,
		source: "remote-datasource",
		sourcePath: fetched.url,
		etag: fetched.etag,
	};
}

function runtimeFetchFailureStage(error: unknown): "network" | "auth" {
	return error instanceof RuntimeAuthError ? "auth" : "network";
}

export function hostedManifestToRuntimeManifest(hosted: HostedRuntimeManifest): RuntimeManifest {
	const home = hosted.system?.home || "/home/clawdi";
	const workspaceRoot = hosted.system?.workspace || join(home, "clawdi");
	const selectedRuntime = hosted.runtime;
	const runtime = hosted.runtimes[selectedRuntime];
	return {
		schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
		deploymentId: hosted.deploymentId,
		environmentId: hosted.environmentId || hosted.appId || hosted.deploymentId,
		instanceId: hosted.instanceId,
		generation: hosted.generation,
		minimumCliVersion: hosted.minimumCliVersion,
		issuedAt: hosted.issuedAt,
		expiresAt: hosted.expiresAt,
		workspaceRoot,
		runtime: selectedRuntime,
		controlPlane: {
			apiUrl: hostedControlPlaneApiUrl(hosted),
		},
		clawdiCli: hosted.clawdiCli
			? {
					...DEFAULT_CLAWDI_CLI_POLICY,
					...hosted.clawdiCli,
					source: hosted.clawdiCli.source ?? DEFAULT_CLAWDI_CLI_POLICY.source,
				}
			: { ...DEFAULT_CLAWDI_CLI_POLICY },
		mitmproxy: hosted.mitmproxy,
		runtimes: {
			[selectedRuntime]: {
				enabled: runtime.enabled,
				updateChannel: runtime.install?.channel,
				install:
					runtime.enabled && runtime.install && OFFICIAL_INSTALL_URLS[selectedRuntime]
						? {
								authority: "official" as const,
								method: "official-installer" as const,
								url: OFFICIAL_INSTALL_URLS[selectedRuntime] ?? "",
								home: runtime.paths?.home || home,
								args: runtime.install?.args ?? OFFICIAL_INSTALL_ARGS[selectedRuntime] ?? [],
							}
						: undefined,
				run: hostedRuntimeRunSettings(runtime.run, runtime.paths?.workspace, workspaceRoot),
				services: Object.fromEntries(
					Object.entries(runtime.services ?? {}).map(([service, run]) => [
						service,
						hostedRuntimeServiceRunSettings(run, runtime.paths?.workspace, workspaceRoot),
					]),
				),
				...hostedRuntimeProviderBinding(runtime),
			},
		},
		bridge: hosted.bridge,
		projection: {
			sourceSchemaVersion: hosted.schemaVersion,
			system: hosted.system ?? null,
			providers: hosted.providers ?? {},
			...(hosted.mcp === undefined ? {} : { mcp: hosted.mcp }),
			...(hosted.tools === undefined ? {} : { tools: hosted.tools }),
		},
		liveSync: hosted.liveSync,
		mitmProfiles: hostedManifestMitmProfiles(hosted),
		recovery: {
			cacheManifest: hosted.recovery?.cacheManifest ?? true,
			allowOfflineBoot: hosted.recovery?.allowOfflineBoot ?? true,
		},
	};
}

function hostedRuntimeProviderBinding(runtime: HostedRuntimeManifest["runtimes"][string]): {
	provider_ids?: string[];
	primary_model?: { provider_id: string; model: string };
} {
	const providerIds = runtime.provider_ids ?? runtime.providerIds;
	const primary = runtime.primary_model ?? runtime.primaryModel;
	const primaryRecord =
		typeof primary === "object" && primary !== null && !Array.isArray(primary)
			? (primary as Record<string, unknown>)
			: null;
	const primaryProviderId =
		typeof primaryRecord?.provider_id === "string"
			? primaryRecord.provider_id
			: typeof primaryRecord?.providerId === "string"
				? primaryRecord.providerId
				: undefined;
	const primaryModel =
		typeof primaryRecord?.model === "string"
			? primaryRecord.model
			: typeof primary === "string"
				? primary
				: undefined;
	const normalizedProviderIds = providerIds?.filter((id) => id.trim().length > 0);
	const fallbackProviderIds =
		primaryProviderId && !normalizedProviderIds?.includes(primaryProviderId)
			? [...(normalizedProviderIds ?? []), primaryProviderId]
			: normalizedProviderIds;
	return {
		...(fallbackProviderIds && fallbackProviderIds.length > 0
			? { provider_ids: fallbackProviderIds }
			: {}),
		...(primaryProviderId && primaryModel
			? { primary_model: { provider_id: primaryProviderId, model: primaryModel } }
			: {}),
	};
}

function hostedRuntimeRunSettings(
	run: RuntimeRunSettings | undefined,
	runtimeWorkspace: string | undefined,
	workspaceRoot: string,
): RuntimeRunSettings | undefined {
	if (!run && !runtimeWorkspace) return undefined;
	const cwd = run?.cwd ?? runtimeWorkspace ?? workspaceRoot;
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
	runtimeWorkspace: string | undefined,
	workspaceRoot: string,
): RuntimeRunSettings {
	return (
		hostedRuntimeRunSettings(run, runtimeWorkspace, workspaceRoot) ?? {
			args: [],
			env: {},
			cwd: runtimeWorkspace ?? workspaceRoot,
			prependPath: [],
		}
	);
}

function hostedControlPlaneApiUrl(hosted: HostedRuntimeManifest): string {
	const explicit = hosted.controlPlane.cloudApiUrl;
	if (explicit) return explicit;
	const manifestUrl = hosted.controlPlane.manifestUrl;
	if (!manifestUrl) return new URL(runtimeManifestUrlFromEnvOrSource()).origin;
	try {
		return new URL(manifestUrl).origin;
	} catch {
		return new URL(runtimeManifestUrlFromEnvOrSource()).origin;
	}
}

function runtimeManifestUrlFromEnvOrSource(): string {
	const explicit = process.env.CLAWDI_RUNTIME_MANIFEST_URL?.trim();
	if (explicit) return explicit;
	const sourcePath =
		process.env.CLAWDI_RUNTIME_SOURCE_PATH?.trim() || "/etc/clawdi/runtime-source.json";
	if (existsSync(sourcePath)) {
		const parsed = runtimeSourceSchema.safeParse(readJsonFile(sourcePath));
		if (parsed.success) return parsed.data.url;
	}
	return "https://runtime.invalid/manifest";
}

function loadExistingState(paths: RuntimePaths): ExistingManifestState {
	if (!existsSync(paths.manifestLastGood)) return {};
	const parsed = parseManifestSafe(readJsonFile(paths.manifestLastGood));
	if (!parsed) return {};
	return {
		instanceId: parsed.instanceId,
		generation: parsed.generation,
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

function validateManifestSemantics(manifest: RuntimeManifest, paths: RuntimePaths): string[] {
	const errors: string[] = [];
	const expiryError = manifestExpiryError(manifest);
	if (expiryError) errors.push(expiryError);
	if (!isAbsolute(paths.userHome)) errors.push(`runtime HOME must be absolute: ${paths.userHome}`);
	if (manifest.workspaceRoot && !isAbsolute(manifest.workspaceRoot)) {
		errors.push(`runtime workspaceRoot must be absolute: ${manifest.workspaceRoot}`);
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
		const surfaces = manifest.bridge?.surfaces ?? [];
		if (runtime === "openclaw" && surfaces.length > 0) {
			const surface = surfaces[0];
			if (
				surfaces.length !== 1 ||
				!surface ||
				surface.name !== "openclaw" ||
				surface.kind !== "control-ui" ||
				surface.listenPort !== 28789 ||
				surface.upstreamHost !== "127.0.0.1" ||
				surface.upstreamPort !== 18789
			) {
				errors.push("openclaw bridge surface must be openclaw control-ui 28789 -> 127.0.0.1:18789");
			}
		}
		if (runtime === "hermes") {
			const surface = surfaces[0];
			if (
				surfaces.length !== 1 ||
				!surface ||
				surface.name !== "hermes" ||
				surface.kind !== "control-ui" ||
				surface.listenPort !== 28793 ||
				surface.upstreamHost !== "127.0.0.1" ||
				surface.upstreamPort !== 9119
			) {
				errors.push("hermes runtime must declare bridge surface 28793 -> 127.0.0.1:9119");
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
			normalized = normalizeManifestPayload(fetched.raw);
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
		normalized = normalizeManifestPayload(raw);
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
		const expiryError = manifestExpiryError(manifest);
		if (expiryError) {
			return {
				mode: "repair",
				stage: "local",
				errors: [`cached ${expiryError}`],
			};
		}
		const secretRefs = manifestSecretRefs(manifest);
		if (secretRefs.length > 0) {
			const cached = loadCachedSecretValues(paths);
			if ("errors" in cached) return cached;
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
	normalized: { manifest: RuntimeManifest; secretValues?: Record<string, string> },
	paths: RuntimePaths,
	source: RuntimeManifestLoad["source"],
	sourcePath: string,
): RuntimeManifestLoad | RuntimeManifestFailure {
	const existing = loadExistingState(paths);
	const manifest = normalized.manifest;
	const semanticErrors = validateManifestSemantics(manifest, paths);
	if (existing.instanceId && existing.instanceId !== manifest.instanceId) {
		semanticErrors.push(
			`manifest instanceId ${manifest.instanceId} does not match last-good instanceId ${existing.instanceId}`,
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
	};
}
