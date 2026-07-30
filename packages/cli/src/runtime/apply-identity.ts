import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const runtimeApplyIdentitySchema = z
	.object({
		generation: z.number().int().positive().safe(),
		manifestETag: canonicalIdentityValue(1, 128),
		applyReceiptId: canonicalIdentityValue(16, 128),
		bootNonce: canonicalIdentityValue(16, 128),
	})
	.strict();

export type RuntimeApplyIdentity = z.infer<typeof runtimeApplyIdentitySchema>;

export interface RuntimeGenerationIdentity {
	generation: number;
	applyGeneration?: number;
}

export function resolveRuntimeApplyGeneration(identity: RuntimeGenerationIdentity): number {
	return identity.applyGeneration ?? identity.generation;
}

export const RUNTIME_APPLY_IDENTITY_FILE_ENV = "CLAWDI_RUNTIME_APPLY_IDENTITY_FILE";
export const HOSTED_RUNTIME_APPLY_IDENTITY_FILE =
	"/var/run/secrets/clawdi-runtime-identity/runtime-apply-identity.json";

const runtimeProjectedEnvironmentSchema = z.record(
	z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	z
		.string()
		.min(1)
		.refine((value) => value === value.trim(), "must not have surrounding whitespace")
		.refine(
			(value) =>
				[...value].every((character) => {
					const code = character.charCodeAt(0);
					return code > 0x1f && code !== 0x7f;
				}),
			"must not contain control characters",
		),
);

const runtimeApplyIdentityFileSchema = runtimeApplyIdentitySchema
	.safeExtend({
		schemaVersion: z.literal("clawdi.runtimeApplyIdentity.v1"),
		runtimeEnv: runtimeProjectedEnvironmentSchema,
	})
	.strict();

type RuntimeApplyIdentityFile = z.infer<typeof runtimeApplyIdentityFileSchema>;

export interface RuntimeApplyContext {
	identity: RuntimeApplyIdentity;
	// null preserves the legacy process-environment contract when no file is configured.
	runtimeEnv: Record<string, string> | null;
	sourcePath: string | null;
}

export const RUNTIME_APPLY_IDENTITY_ENV = {
	generation: "CLAWDI_RUNTIME_GENERATION",
	manifestETag: "CLAWDI_RUNTIME_MANIFEST_ETAG",
	applyReceiptId: "CLAWDI_RUNTIME_APPLY_RECEIPT_ID",
	bootNonce: "CLAWDI_RUNTIME_BOOT_NONCE",
} as const;

export function readRuntimeApplyIdentityFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeApplyIdentity | null {
	const entries = Object.entries(RUNTIME_APPLY_IDENTITY_ENV) as Array<
		[keyof RuntimeApplyIdentity, string]
	>;
	const present = entries.filter(([, name]) => env[name] !== undefined);
	if (present.length === 0) return null;
	if (present.length !== entries.length) {
		const missing = entries.filter(([, name]) => env[name] === undefined).map(([, name]) => name);
		throw new Error(
			`incomplete runtime apply identity environment; missing: ${missing.join(", ")}`,
		);
	}

	const generation = env[RUNTIME_APPLY_IDENTITY_ENV.generation];
	if (!generation || !/^[1-9]\d*$/.test(generation)) {
		throw new Error(
			`${RUNTIME_APPLY_IDENTITY_ENV.generation} must be a canonical positive integer`,
		);
	}
	const parsed = runtimeApplyIdentitySchema.safeParse({
		generation: Number(generation),
		manifestETag: env[RUNTIME_APPLY_IDENTITY_ENV.manifestETag],
		applyReceiptId: env[RUNTIME_APPLY_IDENTITY_ENV.applyReceiptId],
		bootNonce: env[RUNTIME_APPLY_IDENTITY_ENV.bootNonce],
	});
	if (!parsed.success) {
		throw new Error(
			`invalid runtime apply identity environment: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return parsed.data;
}

export function readRuntimeApplyIdentity(
	env: Readonly<Record<string, string | undefined>> = process.env,
	discoveryPath: string = HOSTED_RUNTIME_APPLY_IDENTITY_FILE,
): RuntimeApplyIdentity | null {
	return readRuntimeApplyContext(env, discoveryPath)?.identity ?? null;
}

export function readRuntimeApplyContext(
	env: Readonly<Record<string, string | undefined>> = process.env,
	discoveryPath: string = HOSTED_RUNTIME_APPLY_IDENTITY_FILE,
): RuntimeApplyContext | null {
	const explicitPath = env[RUNTIME_APPLY_IDENTITY_FILE_ENV];
	const configuredPath =
		explicitPath !== undefined
			? explicitPath
			: existsSync(discoveryPath)
				? discoveryPath
				: undefined;
	if (configuredPath === undefined) {
		const identity = readRuntimeApplyIdentityFromEnv(env);
		return identity ? { identity, runtimeEnv: null, sourcePath: null } : null;
	}
	const parsed = readRuntimeApplyIdentityFile(configuredPath);
	const { schemaVersion: _schemaVersion, runtimeEnv, ...identity } = parsed;
	return { identity, runtimeEnv, sourcePath: configuredPath };
}

function readRuntimeApplyIdentityFile(configuredPath: string): RuntimeApplyIdentityFile {
	if (!configuredPath || configuredPath !== configuredPath.trim() || !isAbsolute(configuredPath)) {
		throw new Error(`${RUNTIME_APPLY_IDENTITY_FILE_ENV} must be a canonical absolute path`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configuredPath, "utf-8")) as unknown;
	} catch (error) {
		throw new Error(
			`could not read runtime apply identity file ${configuredPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const parsed = runtimeApplyIdentityFileSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`invalid runtime apply identity file ${configuredPath}: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return parsed.data;
}

export function runtimeApplyIdentityEnvironment(
	identity: RuntimeApplyIdentity | null,
): Record<string, string> {
	if (!identity) return {};
	return {
		[RUNTIME_APPLY_IDENTITY_ENV.generation]: String(identity.generation),
		[RUNTIME_APPLY_IDENTITY_ENV.manifestETag]: identity.manifestETag,
		[RUNTIME_APPLY_IDENTITY_ENV.applyReceiptId]: identity.applyReceiptId,
		[RUNTIME_APPLY_IDENTITY_ENV.bootNonce]: identity.bootNonce,
	};
}

export function runtimeApplyIdentityServiceEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
	discoveryPath: string = HOSTED_RUNTIME_APPLY_IDENTITY_FILE,
): Record<string, string> {
	const explicitPath = env[RUNTIME_APPLY_IDENTITY_FILE_ENV];
	const configuredPath =
		explicitPath !== undefined
			? explicitPath
			: existsSync(discoveryPath)
				? discoveryPath
				: undefined;
	if (configuredPath !== undefined) {
		if (
			!configuredPath ||
			configuredPath !== configuredPath.trim() ||
			!isAbsolute(configuredPath)
		) {
			throw new Error(`${RUNTIME_APPLY_IDENTITY_FILE_ENV} must be a canonical absolute path`);
		}
		return { [RUNTIME_APPLY_IDENTITY_FILE_ENV]: configuredPath };
	}
	return runtimeApplyIdentityEnvironment(readRuntimeApplyIdentityFromEnv(env));
}

function canonicalIdentityValue(min: number, max: number): z.ZodString {
	return z
		.string()
		.min(min)
		.max(max)
		.refine((value) => value === value.trim(), "must not contain surrounding whitespace");
}
