import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
	runtimeContentSha256,
} from "./applied-state";
import {
	type RuntimeApplyContext,
	readRuntimeApplyContext,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentitiesEqual,
} from "./apply-identity";
import { egressProfileSecretRefs } from "./egress-profiles";
import {
	hostedManifestEgressProfiles,
	isClawdiManagedProviderProjection,
} from "./hosted-egress-profiles";
import {
	type HostedRuntimeManifest,
	hostedCliPayloadPolicySchema,
	hostedRuntimeBundleV2ManifestSchema,
	manifestSchema,
	OFFICIAL_INSTALL_URLS,
	officialInstallArgs,
	RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
	type RuntimeManifest,
} from "./manifest-contract";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { isSupportedRuntimeName, type RuntimeRunSettings } from "./run-config";
import {
	canonicalSecretRefName,
	canonicalSecretRefSchema,
	normalizeSecretValues,
	runtimeSecretValue,
} from "./secret-values";
import { managedWhatsAppAuthCredentials } from "./whatsapp-credential-projection";

export interface RuntimeManifestLoad {
	manifest: RuntimeManifest;
	source: "remote-datasource" | "last-good-cache";
	sourcePath: string;
	offline: boolean;
	// Datasource secret values are the sole authority for manifest secret:// refs.
	secretValues?: Record<string, string>;
	// In-memory bootstrap/apply context used to load and bind this desired state.
	applyContext?: RuntimeApplyContext;
	channelBindings?: RuntimeBundleChannelBinding[];
	sourceRevision?: string;
	// Original datasource manifest before local runtime projections are applied.
	sourceManifest?: RuntimeManifest;
	etag?: string;
}

export const HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json";

const runtimeBundleTokenChannelBindingSchema = z
	.object({
		provider: z.enum(["telegram", "discord"]),
		accountKey: z.string().min(1),
		agentTokenSecretRef: canonicalSecretRefSchema,
		placeholderTokenSecretRef: canonicalSecretRefSchema,
	})
	.strict();

const runtimeBundleWhatsAppBindingSchema = z
	.object({
		provider: z.literal("whatsapp"),
		accountId: z.string().uuid(),
		accountKey: z.string().min(1),
		linkId: z.string().uuid(),
		agentTokenSecretRef: canonicalSecretRefSchema,
		placeholderTokenSecretRef: canonicalSecretRefSchema,
		credential: z
			.object({
				id: z.string().uuid(),
				credsSecretRef: canonicalSecretRefSchema,
				authCert: z
					.object({
						SERIAL: z.number().int().nonnegative().safe(),
						ISSUER: z.string().trim().min(1).max(256),
						PUBLIC_KEY: z
							.object({
								type: z.literal("Buffer"),
								data: z.string().min(1),
							})
							.strict(),
					})
					.strict(),
			})
			.strict(),
	})
	.strict();

const runtimeBundleChannelBindingSchema = z.discriminatedUnion("provider", [
	runtimeBundleTokenChannelBindingSchema,
	runtimeBundleWhatsAppBindingSchema,
]);

export type RuntimeBundleChannelBinding = z.infer<typeof runtimeBundleChannelBindingSchema>;

const hostedRuntimeBundleV2Schema = z
	.object({
		schemaVersion: z.literal("clawdi.hosted-runtime.bundle.v2"),
		sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
		manifest: hostedRuntimeBundleV2ManifestSchema,
		applyGeneration: z.number().int().positive().safe().optional(),
		channelBindings: z.array(runtimeBundleChannelBindingSchema),
		secretValues: z.record(canonicalSecretRefSchema, z.string()),
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
		manifest: markHostedRuntimeBundleV2(
			hostedManifestToRuntimeManifest(bundle.manifest, bundle.applyGeneration),
		),
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
	applyContext?: RuntimeApplyContext;
}

export interface RuntimeManifestFailure {
	mode: "repair" | "manifest-rejected";
	stage: "detect" | "local" | "network" | "auth";
	errors: string[];
	rejectedGeneration?: number | null;
	activeGeneration?: number | null;
}

interface ExistingManifestState {
	instanceId?: string;
	generation?: number;
}

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

function normalizeRemoteManifestPayload(value: unknown): {
	manifest: RuntimeManifest;
	secretValues?: Record<string, string>;
	channelBindings?: RuntimeBundleChannelBinding[];
	sourceRevision?: string;
} {
	const hostedResponse = hostedRuntimeBundleV2Schema.parse(value);
	return {
		manifest: markHostedRuntimeBundleV2(
			hostedManifestToRuntimeManifest(hostedResponse.manifest, hostedResponse.applyGeneration),
		),
		secretValues: normalizeSecretValues(hostedResponse.secretValues),
		channelBindings: hostedResponse.channelBindings,
		sourceRevision: hostedResponse.sourceRevision,
	};
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

async function fetchRuntimeManifestPayload(
	applyContext: RuntimeApplyContext,
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
	const url = applyContext.manifestSource.url;
	const token = applyContext.manifestSource.auth.token;
	const timeoutMs = 15_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				accept: HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
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
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
		if (contentType !== HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE) {
			throw new Error(
				`runtime manifest response content-type must be ${HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE}, received ${contentType ?? "missing"}`,
			);
		}
		if (!etag) throw new Error("runtime bundle response is missing its strong ETag");
		return { url, raw: await response.json(), etag };
	} finally {
		clearTimeout(timer);
	}
}

type RemoteRuntimeManifestResult =
	| RuntimeManifestLoad
	| RuntimeManifestFailure
	| RuntimeManifestNotModified;

async function loadRemoteRuntimeManifestPipeline(
	paths: RuntimePaths,
	opts: { ifNoneMatch?: string; applyContext?: RuntimeApplyContext } = {},
): Promise<RemoteRuntimeManifestResult> {
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
	} catch (error) {
		return runtimeApplyContextFailure(error);
	}
	let fetched: Awaited<ReturnType<typeof fetchRuntimeManifestPayload>>;
	try {
		fetched = await fetchRuntimeManifestPayload(applyContext, opts);
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
			...runtimeApplyContextLoadFields(applyContext),
		};
	}

	let normalized: {
		manifest: RuntimeManifest;
		secretValues?: Record<string, string>;
		channelBindings?: RuntimeBundleChannelBinding[];
		sourceRevision?: string;
	};
	try {
		normalized = normalizeRemoteManifestPayload(fetched.raw);
		assertRemoteBundleAuthority(normalized.sourceRevision, fetched.etag);
		assertRuntimeApplyIdentityMatchesManifest(normalized.manifest, applyContext);
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
	if (!("manifest" in loaded)) return loaded;
	return {
		...loaded,
		etag: fetched.etag,
		...runtimeApplyContextLoadFields(applyContext),
	};
}

export async function loadRemoteRuntimeManifest(
	paths: RuntimePaths,
	opts: { ifNoneMatch?: string; applyContext?: RuntimeApplyContext } = {},
): Promise<RemoteRuntimeManifestResult> {
	return loadRemoteRuntimeManifestPipeline(paths, opts);
}

function runtimeApplyContextFailure(error: unknown): RuntimeManifestFailure {
	return {
		mode: "repair",
		stage: "local",
		errors: [error instanceof Error ? error.message : String(error)],
	};
}

function runtimeApplyContextLoadFields(applyContext: RuntimeApplyContext): {
	applyContext: RuntimeApplyContext;
} {
	return { applyContext };
}

function assertRuntimeApplyIdentityMatchesManifest(
	manifest: RuntimeManifest,
	applyContext: RuntimeApplyContext,
): void {
	if (
		applyContext.identity &&
		applyContext.identity.generation !== resolveRuntimeApplyGeneration(manifest)
	) {
		throw new Error(
			`runtime apply identity generation ${applyContext.identity.generation} does not match resolved manifest apply generation ${resolveRuntimeApplyGeneration(manifest)}`,
		);
	}
}

function assertRemoteBundleAuthority(
	sourceRevision: string | undefined,
	etag: string | undefined,
): void {
	if (!sourceRevision) return;
	const expected = `"sha256:${sourceRevision}"`;
	if (etag !== expected) {
		throw new Error(
			`runtime bundle ETag ${etag ?? "missing"} does not match its sourceRevision validator ${expected}`,
		);
	}
}

function runtimeFetchFailureStage(error: unknown): "network" | "auth" {
	return error instanceof RuntimeAuthError ? "auth" : "network";
}

export function hostedManifestToRuntimeManifest(
	hosted: HostedRuntimeManifest,
	applyGeneration?: number,
): RuntimeManifest {
	const paths = getRuntimePaths({ mode: "hosted" });
	const selectedRuntime = hosted.runtime;
	const runtime = hosted.runtimes[selectedRuntime];
	return {
		schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
		deploymentId: hosted.deploymentId,
		environmentId: hosted.environmentId,
		instanceId: hosted.instanceId,
		generation: hosted.generation,
		...(applyGeneration === undefined ? {} : { applyGeneration }),
		issuedAt: hosted.issuedAt,
		expiresAt: hosted.expiresAt,
		locale: hosted.locale,
		runtime: selectedRuntime,
		controlPlane: {
			apiUrl: hosted.controlPlane.cloudApiUrl,
		},
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
				run: hostedRuntimeRunSettings(runtime.run),
				services: Object.fromEntries(
					Object.entries(runtime.services ?? {}).map(([service, run]) => [
						service,
						hostedRuntimeServiceRunSettings(run),
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
			...(hosted.skills === undefined ? {} : { skills: hosted.skills }),
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

function hostedRuntimeRunSettings(run: RuntimeRunSettings | undefined): RuntimeRunSettings {
	const settings: RuntimeRunSettings = {
		env: run?.env ?? {},
		prependPath: run?.prependPath ?? [],
	};
	if (run?.command !== undefined) settings.command = run.command;
	if (run?.args !== undefined) settings.args = run.args;
	if (run?.secretEnv !== undefined) settings.secretEnv = run.secretEnv;
	if (run?.cwd !== undefined) settings.cwd = run.cwd;
	return settings;
}

function hostedRuntimeServiceRunSettings(run: RuntimeRunSettings): RuntimeRunSettings {
	return hostedRuntimeRunSettings(run);
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
	trustDomain: "generic" | "hosted" = "generic",
): string[] {
	const errors: string[] = [];
	const expiryError = manifestExpiryError(manifest);
	if (expiryError) errors.push(expiryError);
	if (!isAbsolute(paths.userHome)) errors.push(`runtime HOME must be absolute: ${paths.userHome}`);
	if (manifest.workspaceRoot && !isAbsolute(manifest.workspaceRoot)) {
		errors.push(`runtime workspaceRoot must be absolute: ${manifest.workspaceRoot}`);
	}
	if (trustDomain !== "generic") {
		const cliPolicy = hostedCliPayloadPolicySchema.safeParse(manifest.clawdiCli);
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
		const prefixIndexes = runtime.install.args.flatMap((arg, index) =>
			arg === "--prefix" ? [index] : [],
		);
		if (prefixIndexes.length > 0) {
			const expectedArgs = officialInstallArgs(name, runtime.install.home);
			const expectedPrefixIndex = expectedArgs.indexOf("--prefix");
			const expectedPrefix =
				expectedPrefixIndex >= 0 ? expectedArgs[expectedPrefixIndex + 1] : undefined;
			const prefixIndex = prefixIndexes[0];
			if (
				prefixIndexes.length !== 1 ||
				expectedPrefix === undefined ||
				runtime.install.args[prefixIndex + 1] !== expectedPrefix
			) {
				errors.push(
					`runtime ${name} install prefix must match the official launcher prefix ${expectedPrefix ?? "none"}`,
				);
			}
		}
	}
	return errors;
}

export async function loadRuntimeManifest(
	paths: RuntimePaths,
	opts: { applyContext?: RuntimeApplyContext } = {},
): Promise<RuntimeManifestLoad | RuntimeManifestFailure> {
	let applyContext: RuntimeApplyContext;
	try {
		applyContext = opts.applyContext ?? readRuntimeApplyContext();
	} catch (error) {
		return runtimeApplyContextFailure(error);
	}
	const remote = await loadRemoteRuntimeManifestPipeline(paths, { applyContext });
	const fetchFailed =
		"errors" in remote &&
		remote.mode === "repair" &&
		(remote.stage === "network" || remote.stage === "auth");
	if (fetchFailed || "notModified" in remote) {
		const cached = loadLastGoodManifest(paths, offlineLastGoodManifestLoadOptions, applyContext);
		if ("manifest" in cached) return cached;
		const fetchErrors =
			"errors" in remote
				? remote.errors
				: [
						"could not fetch runtime manifest: runtime manifest datasource returned 304 without If-None-Match",
					];
		return {
			mode: "repair",
			stage: "network",
			errors: [...fetchErrors, ...cached.errors],
		};
	}
	return remote;
}

interface LastGoodManifestLoadOptions {
	requireOfflineBoot: boolean;
	requireAppliedAuthority: boolean;
	requireSemanticValidity: boolean;
}

const offlineLastGoodManifestLoadOptions: LastGoodManifestLoadOptions = {
	requireOfflineBoot: true,
	requireAppliedAuthority: false,
	requireSemanticValidity: true,
};

function loadLastGoodManifest(
	paths: RuntimePaths,
	opts: LastGoodManifestLoadOptions,
	applyContext: RuntimeApplyContext,
): RuntimeManifestLoad | RuntimeManifestFailure {
	if (!existsSync(paths.manifestLastGood)) {
		return {
			mode: "repair",
			stage: "local",
			errors: ["last-good runtime manifest does not exist"],
		};
	}
	try {
		const manifest = parseManifest(readJsonFile(paths.manifestLastGood));
		if (opts.requireOfflineBoot && manifest.recovery.allowOfflineBoot !== true) {
			return {
				mode: "repair",
				stage: "local",
				errors: ["cached manifest does not allow offline boot"],
			};
		}
		if (opts.requireSemanticValidity) {
			const semanticErrors = validateManifestSemantics(manifest, paths, "hosted");
			if (semanticErrors.length > 0) {
				return {
					mode: "repair",
					stage: "local",
					errors: semanticErrors.map((error) => `cached ${error}`),
				};
			}
		}
		const appliedState = readRuntimeAppliedState(paths);
		const cachedApplyIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		const strictV2Cache =
			manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2";
		if (
			opts.requireOfflineBoot &&
			(strictV2Cache || cachedApplyIdentity !== null) &&
			!runtimeApplyIdentitiesEqual(applyContext.identity, cachedApplyIdentity)
		) {
			return {
				mode: "repair",
				stage: "local",
				errors: [
					"cached strict-v2 apply identity does not match the current runtime apply identity; refusing offline boot",
				],
				activeGeneration: appliedState?.generation ?? null,
			};
		}
		const cached = loadCachedSecretValues(paths);
		if ("errors" in cached) return cached;
		const secretRefs = manifestSecretRefs(manifest);
		if (secretRefs.length > 0) {
			const missingSecretRefs = manifestSecretRefsMissingValues(manifest, cached.secretValues);
			if (missingSecretRefs.length > 0) {
				return {
					mode: "repair",
					stage: "local",
					errors: [
						`cached manifest references secretValues (${missingSecretRefs.join(", ")}); refusing offline boot because cached secret values are missing`,
					],
				};
			}
		}
		if ((strictV2Cache || opts.requireAppliedAuthority) && !appliedState) {
			return {
				mode: "repair",
				stage: "local",
				errors: [
					strictV2Cache
						? "cached strict-v2 manifest has no durable applied authority; refusing offline boot"
						: "cached manifest has no durable applied authority",
				],
			};
		}
		if (
			(strictV2Cache || cachedApplyIdentity || opts.requireAppliedAuthority) &&
			appliedState &&
			(appliedState?.generation !== manifest.generation ||
				resolveRuntimeApplyGeneration(appliedState) !== resolveRuntimeApplyGeneration(manifest) ||
				appliedState.instanceId !== manifest.instanceId ||
				appliedState.contentIdentity.sha256 !==
					runtimeContentSha256({
						manifest,
						secretValues: cached.secretValues,
					}))
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
		if (secretRefs.length > 0) {
			return {
				manifest,
				source: "last-good-cache",
				sourcePath: paths.manifestLastGood,
				offline: true,
				secretValues: cached.secretValues,
				...runtimeApplyContextLoadFields(applyContext),
			};
		}
		return {
			manifest,
			source: "last-good-cache",
			sourcePath: paths.manifestLastGood,
			offline: true,
			...runtimeApplyContextLoadFields(applyContext),
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

// Internal recovery input for convergence rollback only. This does not
// authorize the cached manifest to boot or converge under current semantics;
// schema parsing plus an exact root-only applied content identity prove only
// the previously committed secret material needed to roll back the sidecar.
export function loadCommittedRuntimeManifest(
	paths: RuntimePaths,
	applyContext: RuntimeApplyContext,
): RuntimeManifestLoad | RuntimeManifestFailure {
	return loadLastGoodManifest(
		paths,
		{
			requireOfflineBoot: false,
			requireAppliedAuthority: true,
			requireSemanticValidity: false,
		},
		applyContext,
	);
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

export function manifestSecretRefs(manifest: RuntimeManifest): string[] {
	const refs = new Set<string>();
	const providers = plainRecord(manifest.projection?.providers);
	let hasEnabledRuntime = false;
	for (const [runtimeName, runtime] of Object.entries(manifest.runtimes)) {
		if (!runtime.enabled) continue;
		hasEnabledRuntime = true;
		addSecretEnvRefs(runtime.run?.secretEnv, refs);
		for (const service of Object.values(runtime.services ?? {})) {
			addSecretEnvRefs(service.secretEnv, refs);
		}
		if (runtimeName === "openclaw" && manifest.openclawGatewayAuth) {
			refs.add(manifest.openclawGatewayAuth.tokenRef);
		}
		if (runtimeName === "hermes" && runtime.services?.dashboard && manifest.hermesDashboardAuth) {
			refs.add(manifest.hermesDashboardAuth.passwordSecretRef);
			refs.add(manifest.hermesDashboardAuth.sessionSecretRef);
		}
		for (const providerId of runtime.provider_ids ?? []) {
			const provider = plainRecord(providers?.[providerId]);
			if (!provider || isClawdiManagedProviderProjection(provider)) continue;
			if (typeof provider.apiKeySecretRef === "string") {
				refs.add(provider.apiKeySecretRef);
			}
			const auth = plainRecord(provider.auth);
			if (typeof auth?.credentialSecretRef === "string") {
				refs.add(auth.credentialSecretRef);
			}
		}
	}
	if (hasEnabledRuntime) {
		for (const ref of egressProfileSecretRefs(manifest.egressProfiles)) refs.add(ref);
		for (const credential of managedWhatsAppAuthCredentials(
			manifest.projection?.channelCredentials,
		)) {
			refs.add(credential.credsJsonSecretRef);
		}
	}
	return [...refs].sort();
}

function manifestSecretRefsMissingValues(
	manifest: RuntimeManifest,
	secretValues: Record<string, string> | undefined,
): string[] {
	const normalizedValues = normalizeSecretValues(secretValues ?? {});
	return manifestSecretRefs(manifest).filter(
		(ref) => runtimeSecretValue(normalizedValues, ref) === null,
	);
}

function addSecretEnvRefs(secretEnv: Record<string, string> | undefined, refs: Set<string>): void {
	for (const ref of Object.values(secretEnv ?? {})) refs.add(ref);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
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
	const semanticErrors = validateManifestSemantics(manifest, paths, "hosted");
	if (existing.instanceId && existing.instanceId !== manifest.instanceId) {
		semanticErrors.push(
			`manifest instanceId ${manifest.instanceId} does not match applied instanceId ${existing.instanceId}`,
		);
	}
	if (
		existing.instanceId === manifest.instanceId &&
		existing.generation !== undefined &&
		manifest.generation < existing.generation
	) {
		semanticErrors.push(
			`manifest generation ${manifest.generation} is older than applied generation ${existing.generation}`,
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
