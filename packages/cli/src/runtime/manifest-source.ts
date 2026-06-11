import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { hostedManifestMitmProfiles, normalizeSecretRef } from "./hosted-mitm-profiles";
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
import type { RuntimeRunSettings } from "./run-config";

export interface RuntimeManifestLoad {
	manifest: RuntimeManifest;
	source: "fixture-file" | "remote-datasource" | "last-good-cache";
	sourcePath: string;
	offline: boolean;
	secretValues?: Record<string, string>;
}

export interface RuntimeManifestFailure {
	mode: "repair" | "manifest-rejected";
	stage: "detect" | "local" | "network";
	errors: string[];
	rejectedGeneration?: number | null;
	activeGeneration?: number | null;
}

interface ExistingManifestState {
	instanceId?: string;
	generation?: number;
}

const runtimeSourceAuthSchema = z
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
		auth: runtimeSourceAuthSchema.default({ type: "bearer-env", env: "CLAWDI_AUTH_TOKEN" }),
		timeoutMs: z.number().int().positive().optional(),
	})
	.strict();

type RuntimeSource = z.infer<typeof runtimeSourceSchema>;

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

function parseManifestSafe(value: unknown): RuntimeManifest | null {
	const result = manifestSchema.safeParse(value);
	return result.success ? result.data : null;
}

function normalizeManifestPayload(value: unknown): {
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

function runtimeCredential(source: RuntimeSource): string | null {
	const token = process.env[source.auth.env]?.trim();
	return token || null;
}

function resolveRuntimeSource(paths: RuntimePaths): RuntimeSource {
	const explicit = process.env.CLAWDI_RUNTIME_MANIFEST_URL?.trim();
	if (explicit) {
		return {
			schemaVersion: "clawdi.runtimeSource.v1",
			type: "http",
			url: explicit,
			auth: {
				type: "bearer-env",
				env: process.env.CLAWDI_RUNTIME_AUTH_ENV?.trim() || "CLAWDI_AUTH_TOKEN",
			},
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

export function runtimeSourceAuthEnv(paths: RuntimePaths): string {
	return resolveRuntimeSource(paths).auth.env;
}

async function fetchRuntimeManifestPayload(paths: RuntimePaths): Promise<{
	url: string;
	raw: unknown;
}> {
	const source = resolveRuntimeSource(paths);
	const token = runtimeCredential(source);
	if (!token) {
		throw new Error(`missing ${source.auth.env}`);
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
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`runtime manifest request failed: HTTP ${response.status}${
					detail ? ` ${detail.slice(0, 200)}` : ""
				}`,
			);
		}
		return { url, raw: await response.json() };
	} finally {
		clearTimeout(timer);
	}
}

function hostedManifestToRuntimeManifest(hosted: HostedRuntimeManifest): RuntimeManifest {
	const home = hosted.system?.home || "/home/clawdi";
	const workspaceRoot = hosted.system?.workspace || join(home, "clawdi");
	return {
		schemaVersion: RUNTIME_DESIRED_STATE_SCHEMA_VERSION,
		deploymentId: hosted.deploymentId,
		environmentId: hosted.environmentId || hosted.appId || hosted.deploymentId,
		instanceId: hosted.instanceId,
		generation: hosted.generation,
		issuedAt: hosted.issuedAt,
		expiresAt: hosted.expiresAt,
		workspaceRoot,
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
		runtimes: Object.fromEntries(
			Object.entries(hosted.runtimes).map(([name, runtime]) => [
				name,
				{
					enabled: runtime.enabled,
					updateChannel: runtime.install?.channel,
					install: runtime.enabled
						? {
								authority: "official" as const,
								method: "official-installer" as const,
								url: OFFICIAL_INSTALL_URLS[name] ?? "",
								home: runtime.paths?.home || home,
								args: runtime.install?.args ?? OFFICIAL_INSTALL_ARGS[name] ?? [],
							}
						: undefined,
					run: hostedRuntimeRunSettings(runtime.run, runtime.paths?.workspace, workspaceRoot),
				},
			]),
		),
		projection: {
			sourceSchemaVersion: hosted.schemaVersion,
			system: hosted.system ?? null,
			providers: hosted.providers ?? {},
		},
		liveSync: hosted.liveSync,
		mitmProfiles: hostedManifestMitmProfiles(hosted),
		recovery: {
			cacheManifest: hosted.recovery?.cacheManifest ?? true,
			allowOfflineBoot: hosted.recovery?.allowOfflineBoot ?? true,
		},
	};
}

function hostedRuntimeRunSettings(
	run: RuntimeRunSettings | undefined,
	runtimeWorkspace: string | undefined,
	workspaceRoot: string,
): RuntimeRunSettings | undefined {
	if (!run && !runtimeWorkspace) return undefined;
	const cwd = run?.cwd ?? runtimeWorkspace ?? workspaceRoot;
	return {
		command: run?.command,
		args: run?.args ?? [],
		env: run?.env ?? {},
		cwd,
		prependPath: run?.prependPath ?? [],
	};
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

function normalizeSecretValues(secretValues: Record<string, string>): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [ref, value] of Object.entries(secretValues)) {
		normalized[ref] = value;
		const secretRef = normalizeSecretRef(ref);
		if (secretRef && normalized[secretRef] === undefined) {
			normalized[secretRef] = value;
		}
	}
	return normalized;
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
	for (const [name, runtime] of Object.entries(manifest.runtimes)) {
		if (!runtime.enabled) continue;
		if (name !== "openclaw" && name !== "hermes") {
			errors.push(`runtime ${name} is not supported by the hosted runtime simulator`);
			continue;
		}
		if (!runtime.install) {
			errors.push(`runtime ${name} is enabled but missing install metadata`);
			continue;
		}
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
		let fetched: { url: string; raw: unknown };
		try {
			fetched = await fetchRuntimeManifestPayload(paths);
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
		return validateLoadedManifest(normalized, paths, "remote-datasource", fetched.url);
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
	if (existing.generation !== undefined && manifest.generation < existing.generation) {
		semanticErrors.push(
			`manifest generation ${manifest.generation} is older than last-good generation ${existing.generation}`,
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
