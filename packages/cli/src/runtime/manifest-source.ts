import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { toErrorMessage } from "../serve/log";
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
import { applyRuntimeBundleChannelsToManifestLoad } from "./channels";
import { egressProfileSecretRefs } from "./egress-profiles";
import { isClawdiManagedProviderProjection } from "./hosted-egress-profiles";
import {
	HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION,
	hostedRuntimeBundleV2ManifestSchema,
	type RuntimeManifest,
	validateUnmanagedProviderSecretValues,
} from "./manifest-contract";
import type { RuntimePaths } from "./paths";
import {
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
	// Validated wire bundle with secretValues persisted separately.
	sourceBundle?: unknown;
	etag?: string;
}

export const HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE = "application/vnd.clawdi.runtime-bundle.v2+json";
export const HOSTED_RUNTIME_CAPABILITIES_HEADER = "x-clawdi-runtime-capabilities";
export const HOSTED_AGENT_PLUGIN_MANIFEST_CAPABILITY = "agent-plugins-manifest-v1";
export const HOSTED_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY =
	"agent-plugin-github-release-source-v1";

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

export const hostedRuntimeBundleV2Schema = z
	.object({
		schemaVersion: z.literal(HOSTED_RUNTIME_BUNDLE_V2_SCHEMA_VERSION),
		sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
		manifest: z.unknown(),
		applyGeneration: z.number().int().positive().safe().optional(),
		channelBindings: z.array(runtimeBundleChannelBindingSchema),
		secretValues: z.record(canonicalSecretRefSchema, z.string()),
	})
	.strict()
	.transform((bundle, ctx) => {
		const manifest = hostedRuntimeBundleV2ManifestSchema.safeParse(bundle.manifest);
		if (!manifest.success) {
			for (const issue of manifest.error.issues) {
				ctx.addIssue({ ...issue, path: ["manifest", ...issue.path] });
			}
			return z.NEVER;
		}
		return {
			...bundle,
			sourceBundle: { ...bundle, secretValues: {} },
			manifest: {
				...manifest.data,
				...(bundle.applyGeneration === undefined
					? {}
					: { applyGeneration: bundle.applyGeneration }),
			},
		};
	})
	.superRefine(validateUnmanagedProviderSecretValues);

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
	etag?: string;
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

class RuntimeManifestResponseError extends Error {
	constructor(
		message: string,
		readonly etag: string | undefined,
	) {
		super(message);
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

export function parseHostedRuntimeBundleV2(
	value: unknown,
	sourcePath: string,
): RuntimeManifestLoad {
	const hostedResponse = hostedRuntimeBundleV2Schema.parse(value);
	return {
		manifest: hostedResponse.manifest,
		sourceBundle: hostedResponse.sourceBundle,
		source: "remote-datasource",
		sourcePath,
		offline: false,
		secretValues: normalizeSecretValues(hostedResponse.secretValues),
		channelBindings: hostedResponse.channelBindings,
		sourceRevision: hostedResponse.sourceRevision,
	};
}

function rawGeneration(value: unknown): number | null {
	const generation = plainRecord(plainRecord(value)?.manifest)?.generation;
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
				[HOSTED_RUNTIME_CAPABILITIES_HEADER]: [
					HOSTED_AGENT_PLUGIN_MANIFEST_CAPABILITY,
					HOSTED_AGENT_PLUGIN_GITHUB_RELEASE_SOURCE_CAPABILITY,
				].join(", "),
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
			throw new RuntimeManifestResponseError(
				`runtime manifest response content-type must be ${HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE}, received ${contentType ?? "missing"}`,
				etag,
			);
		}
		if (!etag) throw new Error("runtime bundle response is missing its strong ETag");
		try {
			return { url, raw: await response.json(), etag };
		} catch (error) {
			throw new RuntimeManifestResponseError(
				`runtime manifest response is not valid JSON: ${toErrorMessage(error)}`,
				etag,
			);
		}
	} finally {
		clearTimeout(timer);
	}
}

type RemoteRuntimeManifestResult =
	| RuntimeManifestLoad
	| RuntimeManifestFailure
	| RuntimeManifestNotModified;

export async function loadRemoteRuntimeManifest(
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
			errors: [`could not fetch runtime manifest: ${toErrorMessage(error)}`],
			...(error instanceof RuntimeManifestResponseError && error.etag ? { etag: error.etag } : {}),
		};
	}
	if ("notModified" in fetched) {
		return {
			source: "remote-datasource",
			sourcePath: fetched.url,
			notModified: true,
			etag: fetched.etag ?? opts.ifNoneMatch,
			applyContext,
		};
	}

	let normalized: RuntimeManifestLoad;
	try {
		normalized = parseHostedRuntimeBundleV2(fetched.raw, fetched.url);
		assertRuntimeBundleAuthority(normalized.sourceRevision, fetched.etag);
		assertRuntimeApplyIdentityMatchesManifest(normalized.manifest, applyContext);
	} catch (error) {
		return {
			mode: "manifest-rejected",
			stage: "network",
			errors: error instanceof z.ZodError ? zodErrors(error) : [toErrorMessage(error)],
			etag: fetched.etag,
			rejectedGeneration: rawGeneration(fetched.raw),
			activeGeneration: loadExistingState(paths).generation ?? null,
		};
	}
	const loaded = validateLoadedManifest(normalized, paths);
	if (!("manifest" in loaded)) {
		return {
			...loaded,
			etag: fetched.etag,
		};
	}
	return {
		...loaded,
		etag: fetched.etag,
		applyContext,
	};
}

function runtimeApplyContextFailure(error: unknown): RuntimeManifestFailure {
	return {
		mode: "repair",
		stage: "local",
		errors: [toErrorMessage(error)],
	};
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

export function assertRuntimeBundleAuthority(
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

function loadExistingState(paths: RuntimePaths): ExistingManifestState {
	const appliedState = readRuntimeAppliedState(paths);
	if (!appliedState) return {};
	return {
		instanceId: appliedState.instanceId,
		generation: appliedState.generation,
	};
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
	const remote = await loadRemoteRuntimeManifest(paths, { applyContext });
	const fetchFailed =
		"errors" in remote &&
		remote.mode === "repair" &&
		(remote.stage === "network" || remote.stage === "auth");
	if (fetchFailed || "notModified" in remote) {
		const cached = loadLastGoodManifest(paths, true, applyContext);
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

function loadLastGoodManifest(
	paths: RuntimePaths,
	requireOfflineBoot: boolean,
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
		const sourceBundle = readJsonFile(paths.manifestLastGood);
		const cachedBundle = plainRecord(sourceBundle);
		if (!cachedBundle) throw new Error("cached runtime bundle must be an object");
		const cached = loadCachedSecretValues(paths);
		if ("errors" in cached) return cached;
		const parsed = parseHostedRuntimeBundleV2(
			{ ...cachedBundle, secretValues: cached.secretValues },
			paths.manifestLastGood,
		);
		const appliedState = readRuntimeAppliedState(paths);
		const restored = applyRuntimeBundleChannelsToManifestLoad(
			{
				...parsed,
				source: "last-good-cache",
				sourcePath: paths.manifestLastGood,
				offline: true,
				applyContext,
			},
			paths,
		);
		const manifest = restored.manifest;
		if (requireOfflineBoot && manifest.recovery.allowOfflineBoot !== true) {
			return {
				mode: "repair",
				stage: "local",
				errors: ["cached manifest does not allow offline boot"],
			};
		}
		const cachedApplyIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (
			requireOfflineBoot &&
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
		if (!appliedState) {
			return {
				mode: "repair",
				stage: "local",
				errors: ["cached manifest has no durable applied authority; refusing offline boot"],
			};
		}
		if (
			appliedState.generation !== manifest.generation ||
			resolveRuntimeApplyGeneration(appliedState) !== resolveRuntimeApplyGeneration(manifest) ||
			appliedState.instanceId !== manifest.instanceId ||
			appliedState.contentIdentity.sha256 !==
				runtimeContentSha256({
					manifest: sourceBundle,
					secretValues: cached.secretValues,
				})
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
		return {
			...restored,
			manifest,
		};
	} catch (error) {
		return {
			mode: "repair",
			stage: "local",
			errors: [
				`could not read last-good runtime manifest at ${paths.manifestLastGood}: ${toErrorMessage(error)}`,
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
	return loadLastGoodManifest(paths, false, applyContext);
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
				`could not read cached runtime secret values at ${paths.managedSecretCacheFile}: ${toErrorMessage(error)}`,
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
	normalized: RuntimeManifestLoad,
	paths: RuntimePaths,
): RuntimeManifestLoad | RuntimeManifestFailure {
	const existing = loadExistingState(paths);
	const manifest = normalized.manifest;
	const continuityErrors: string[] = [];
	if (existing.instanceId && existing.instanceId !== manifest.instanceId) {
		continuityErrors.push(
			`manifest instanceId ${manifest.instanceId} does not match applied instanceId ${existing.instanceId}`,
		);
	}
	if (
		existing.instanceId === manifest.instanceId &&
		existing.generation !== undefined &&
		manifest.generation < existing.generation
	) {
		continuityErrors.push(
			`manifest generation ${manifest.generation} is older than applied generation ${existing.generation}`,
		);
	}
	if (continuityErrors.length > 0) {
		return {
			mode: "manifest-rejected",
			stage: normalized.source === "remote-datasource" ? "network" : "local",
			errors: continuityErrors,
			rejectedGeneration: manifest.generation,
			activeGeneration: existing.generation ?? null,
		};
	}
	return normalized;
}
