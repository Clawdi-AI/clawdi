import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { type ProjectedRuntimeEnvironment, projectedRuntimeEnvironment } from "./secret-values";

export const runtimeApplyIdentitySchema = z
	.object({
		generation: z.number().int().positive().safe(),
		manifestETag: canonicalIdentityValue(1, 128),
		applyReceiptId: canonicalIdentityValue(16, 128),
		bootNonce: canonicalIdentityValue(16, 128),
	})
	.strict();

export type RuntimeApplyIdentity = z.infer<typeof runtimeApplyIdentitySchema>;

interface RuntimeGenerationIdentity {
	generation: number;
	applyGeneration?: number;
}

export function resolveRuntimeApplyGeneration(identity: RuntimeGenerationIdentity): number {
	return identity.applyGeneration ?? identity.generation;
}

export function runtimeApplyIdentitiesEqual(
	left: RuntimeApplyIdentity | null,
	right: RuntimeApplyIdentity | null,
): boolean {
	if (left === null || right === null) return left === right;
	return (
		left.generation === right.generation &&
		left.manifestETag === right.manifestETag &&
		left.applyReceiptId === right.applyReceiptId &&
		left.bootNonce === right.bootNonce
	);
}

const RUNTIME_APPLY_IDENTITY_FILE_ENV = "CLAWDI_RUNTIME_APPLY_IDENTITY_FILE";
const HOSTED_RUNTIME_APPLY_IDENTITY_FILE =
	"/etc/clawdi/runtime-identity/runtime-apply-identity.json";

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
	kind: "identity-file";
	identity: RuntimeApplyIdentity;
	sourcePath: string;
	runtimeEnvironment: ProjectedRuntimeEnvironment;
}

export function readRuntimeApplyIdentity(
	env: Readonly<Record<string, string | undefined>> = process.env,
	discoveryPath: string = HOSTED_RUNTIME_APPLY_IDENTITY_FILE,
): RuntimeApplyIdentity {
	return readRuntimeApplyContext(env, discoveryPath).identity;
}

export function readRuntimeApplyContext(
	env: Readonly<Record<string, string | undefined>> = process.env,
	discoveryPath: string = HOSTED_RUNTIME_APPLY_IDENTITY_FILE,
): RuntimeApplyContext {
	const configuredPath = configuredRuntimeApplyIdentityPath(env, discoveryPath);
	const parsed = readRuntimeApplyIdentityFile(configuredPath);
	const { schemaVersion: _schemaVersion, runtimeEnv, ...identity } = parsed;
	return {
		kind: "identity-file",
		identity,
		sourcePath: configuredPath,
		runtimeEnvironment: projectedRuntimeEnvironment(runtimeEnv),
	};
}

function readRuntimeApplyIdentityFile(configuredPath: string): RuntimeApplyIdentityFile {
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

export function runtimeApplyContextServiceEnvironment(
	context: RuntimeApplyContext,
): Record<string, string> {
	return { [RUNTIME_APPLY_IDENTITY_FILE_ENV]: context.sourcePath };
}

function configuredRuntimeApplyIdentityPath(
	env: Readonly<Record<string, string | undefined>>,
	discoveryPath: string,
): string {
	const explicitPath = env[RUNTIME_APPLY_IDENTITY_FILE_ENV];
	const configuredPath =
		explicitPath !== undefined ? explicitPath : existsSync(discoveryPath) ? discoveryPath : null;
	if (configuredPath === null) {
		throw new Error(`missing runtime apply identity file ${discoveryPath}`);
	}
	if (!configuredPath || configuredPath !== configuredPath.trim() || !isAbsolute(configuredPath)) {
		throw new Error(`${RUNTIME_APPLY_IDENTITY_FILE_ENV} must be a canonical absolute path`);
	}
	return configuredPath;
}

function canonicalIdentityValue(min: number, max: number): z.ZodString {
	return z
		.string()
		.min(min)
		.max(max)
		.refine((value) => value === value.trim(), "must not contain surrounding whitespace");
}
