import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
	HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE,
	hostedCliPackageSpecSchema,
} from "./manifest-contract";
import { getRuntimePaths } from "./paths";

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

export const HOSTED_RUNTIME_CONTEXT_FILE = getRuntimePaths({ mode: "hosted" }).runtimeContextFile;
const TEST_RUNTIME_CONTEXT_FILE_ENV = "CLAWDI_RUNTIME_TEST_CONTEXT_FILE";

const runtimeBootstrapSecretSchema = z
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
	);

export const runtimeManifestSourceSchema = z
	.object({
		type: z.literal("http"),
		url: z.url().refine((value) => {
			const url = new URL(value);
			return (
				(url.protocol === "https:" || url.protocol === "http:") &&
				!url.username &&
				!url.password &&
				!url.hash &&
				url.pathname.endsWith("/v1/runtime/manifest")
			);
		}, "must be an HTTP(S) /v1/runtime/manifest URL without credentials or a fragment"),
		auth: z
			.object({
				type: z.literal("bearer"),
				token: runtimeBootstrapSecretSchema,
			})
			.strict(),
	})
	.strict();

export type RuntimeManifestSource = z.infer<typeof runtimeManifestSourceSchema>;

const runtimeContextFileSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeContext.v2"),
		backend: z.literal("incus").optional(),
		apply: runtimeApplyIdentitySchema,
		cliPackageSpec: hostedCliPackageSpecSchema.or(
			z.literal(HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE),
		),
		manifestSource: runtimeManifestSourceSchema,
	})
	.strict();

type RuntimeContextFile = z.infer<typeof runtimeContextFileSchema>;

export interface RuntimeApplyContext {
	kind: "context-file";
	backend?: "incus";
	identity: RuntimeApplyIdentity;
	cliPackageSpec: string;
	manifestSource: RuntimeManifestSource;
}

export function readRuntimeApplyIdentity(
	contextPath: string = runtimeContextFilePath(),
): RuntimeApplyIdentity {
	return readRuntimeApplyContext(contextPath).identity;
}

export function readRuntimeApplyContext(
	contextPath: string = runtimeContextFilePath(),
): RuntimeApplyContext {
	const parsed = readRuntimeContextFile(contextPath);
	return {
		kind: "context-file",
		...(parsed.backend === undefined ? {} : { backend: parsed.backend }),
		identity: parsed.apply,
		cliPackageSpec: parsed.cliPackageSpec,
		manifestSource: parsed.manifestSource,
	};
}

function runtimeContextFilePath(): string {
	const testPath = process.env[TEST_RUNTIME_CONTEXT_FILE_ENV];
	if (testPath === undefined) return HOSTED_RUNTIME_CONTEXT_FILE;
	if (process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1") {
		throw new Error(
			`${TEST_RUNTIME_CONTEXT_FILE_ENV} is available only with CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`,
		);
	}
	if (!testPath || testPath !== testPath.trim() || !isAbsolute(testPath)) {
		throw new Error(`${TEST_RUNTIME_CONTEXT_FILE_ENV} must be a canonical absolute path`);
	}
	return testPath;
}

function readRuntimeContextFile(contextPath: string): RuntimeContextFile {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(contextPath, "utf-8"));
	} catch (error) {
		throw new Error(
			`could not read runtime context file ${contextPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const parsed = runtimeContextFileSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`invalid runtime context file ${contextPath}: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	if (
		parsed.data.cliPackageSpec === HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE &&
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS !== "1"
	) {
		throw new Error(
			`invalid runtime context file ${contextPath}: cliPackageSpec: ${HOSTED_RUNTIME_PAIRED_FIXTURE_CLI_PACKAGE} requires CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS=1`,
		);
	}
	return parsed.data;
}

function canonicalIdentityValue(min: number, max: number): z.ZodString {
	return z
		.string()
		.min(min)
		.max(max)
		.refine((value) => value === value.trim(), "must not contain surrounding whitespace");
}
