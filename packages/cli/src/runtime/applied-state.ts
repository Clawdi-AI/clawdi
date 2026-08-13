import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import {
	type RuntimeApplyIdentity,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentitySchema,
} from "./apply-identity";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

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
		applyGeneration: z.number().int().positive().safe().optional(),
		manifestETag: z.string().min(1).max(128).optional(),
		applyReceiptId: z.string().min(16).max(128).optional(),
		bootNonce: z.string().min(16).max(128).optional(),
		contentIdentity: appliedContentSourceSchema,
		egressSidecarSecretRevision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		daemonAuthTokenRevision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		daemonProgramRevision: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.optional(),
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
		if (present === applyFields.length && resolveRuntimeApplyGeneration(state) < 1) {
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
		generation: resolveRuntimeApplyGeneration(state),
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
		secureRuntimeAppliedStateFile(paths.appliedState);
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
	writeRuntimePlatformFileAtomic(
		paths,
		paths.appliedState,
		`${JSON.stringify(parsed, null, 2)}\n`,
		{
			mode: 0o600,
			dirMode: 0o755,
		},
	);
	secureRuntimeAppliedStateFile(paths.appliedState);
	return paths.appliedState;
}

function secureRuntimeAppliedStateFile(path: string): void {
	if (typeof process.getuid !== "function") return;
	const stat = statSync(path);
	if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
	if (process.getuid() === 0 && (stat.uid !== 0 || stat.gid !== 0)) chownSync(path, 0, 0);
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
