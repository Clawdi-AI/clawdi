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

function canonicalIdentityValue(min: number, max: number): z.ZodString {
	return z
		.string()
		.min(min)
		.max(max)
		.refine((value) => value === value.trim(), "must not contain surrounding whitespace");
}
