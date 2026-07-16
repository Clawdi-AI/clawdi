import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writePrivateFileAtomic } from "../lib/private-file";
import { type RuntimeApplyIdentity, runtimeApplyIdentitySchema } from "./apply-identity";
import type { RuntimePaths } from "./paths";

const appliedContentSourceSchema = z
	.object({
		sourcePath: z.string().min(1),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

const projectedProviderIdsSchema = z.record(
	z.string().min(1),
	z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length, {
		message: "projected provider IDs must be unique",
	}),
);

const providerIdsSchema = z
	.array(z.string().min(1))
	.refine((ids) => new Set(ids).size === ids.length, {
		message: "provider IDs must be unique",
	});

export const runtimeAppliedStateSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeAppliedState.v2"),
		appliedAt: z.string().datetime({ offset: true }),
		instanceId: z.string().min(1),
		etag: z.string().min(1),
		sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
		generation: z.number().int().nonnegative(),
		manifestETag: z.string().min(1).max(128).optional(),
		applyReceiptId: z.string().min(16).max(128).optional(),
		bootNonce: z.string().min(16).max(128).optional(),
		contentIdentity: appliedContentSourceSchema,
		providerIds: providerIdsSchema,
		projectedProviderIds: projectedProviderIdsSchema,
	})
	.strict()
	.superRefine((state, ctx) => {
		const applyFields = [state.manifestETag, state.applyReceiptId, state.bootNonce];
		const present = applyFields.filter((value) => value !== undefined).length;
		if (present !== 0 && present !== applyFields.length) {
			ctx.addIssue({
				code: "custom",
				message: "manifestETag, applyReceiptId, and bootNonce must be present together",
				path: ["manifestETag"],
			});
		}
		if (present === applyFields.length && state.generation < 1) {
			ctx.addIssue({
				code: "custom",
				message: "apply identity generation must be at least 1",
				path: ["generation"],
			});
		}
	});

export type RuntimeAppliedState = z.infer<typeof runtimeAppliedStateSchema>;
export type RuntimeAppliedStateV2 = RuntimeAppliedState;
export type RuntimeAppliedContentSource = z.infer<typeof appliedContentSourceSchema>;
export type RuntimeAppliedContentIdentity = RuntimeAppliedContentSource;

export function runtimeAppliedApplyIdentity(
	state: RuntimeAppliedState,
): RuntimeApplyIdentity | null {
	if (
		state.manifestETag === undefined ||
		state.applyReceiptId === undefined ||
		state.bootNonce === undefined
	) {
		return null;
	}
	const parsed = runtimeApplyIdentitySchema.safeParse({
		generation: state.generation,
		manifestETag: state.manifestETag,
		applyReceiptId: state.applyReceiptId,
		bootNonce: state.bootNonce,
	});
	return parsed.success ? parsed.data : null;
}

export function runtimeContentSha256(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

export function readRuntimeAppliedState(paths: RuntimePaths): RuntimeAppliedState | null {
	if (!existsSync(paths.appliedState)) return null;
	try {
		const raw = JSON.parse(readFileSync(paths.appliedState, "utf-8")) as unknown;
		const parsed = runtimeAppliedStateSchema.safeParse(raw);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function writeRuntimeAppliedState(
	state: RuntimeAppliedStateV2,
	paths: RuntimePaths,
): string {
	const parsed = runtimeAppliedStateSchema.parse(state);
	writePrivateFileAtomic(paths.appliedState, `${JSON.stringify(parsed, null, 2)}\n`, {
		mode: 0o644,
		dirMode: 0o755,
	});
	return paths.appliedState;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map((key) => [key, canonicalize(record[key])]),
		);
	}
	return value;
}
