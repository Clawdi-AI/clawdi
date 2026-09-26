import { createHash } from "node:crypto";
import { chmodSync, chownSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { log, toErrorMessage } from "../serve/log";
import {
	type RuntimeApplyIdentity,
	resolveRuntimeApplyGeneration,
	runtimeApplyIdentitySchema,
} from "./apply-identity";
import { hostedSkillEvidenceSchema } from "./hosted-skill-evidence";
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

const officialServiceCommandRevisionsSchema = z.record(
	z.string().regex(/^[A-Za-z0-9_.@-]+\.service$/),
	z.string().regex(/^[a-f0-9]{64}$/),
);

const activatedSystemdUnitsSchema = z.record(
	z.string().regex(/^[A-Za-z0-9_.@-]+\.service$/),
	z.string().regex(/^[a-f0-9]{64}$/),
);

const providerIdsSchema = z
	.array(z.string().min(1))
	.refine((ids) => new Set(ids).size === ids.length, {
		message: "provider IDs must be unique",
	});

const RUNTIME_PROVIDER_CONFLICT_LIMIT = 64;
const runtimeProviderConflictSchema = z
	.object({
		runtime: z.enum(["hermes", "openclaw"]),
		providerId: z.string().regex(/^[a-z][a-z0-9._-]{0,119}$/),
		code: z.enum(["native_provider_exists", "native_credential_pool_conflict"]),
	})
	.strict();
export type RuntimeProviderConflict = z.infer<typeof runtimeProviderConflictSchema>;

/** Unique, sorted, wire-valid entries; a malformed entry is skipped but never reported. */
function canonicalRuntimeEntries<T>(
	schema: z.ZodType<T>,
	entries: readonly unknown[],
	key: (entry: T) => string,
	limit: number,
): T[] {
	const valid = new Map<string, T>();
	for (const entry of entries) {
		const parsed = schema.safeParse(entry);
		if (parsed.success) valid.set(key(parsed.data), parsed.data);
	}
	return [...valid.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, entry]) => entry)
		.slice(0, limit);
}

export function runtimeProviderConflicts(
	entries: readonly { runtime: string; providerId: string; code: string }[],
): RuntimeProviderConflict[] {
	return canonicalRuntimeEntries(
		runtimeProviderConflictSchema,
		entries,
		(entry) => `${entry.runtime}\0${entry.providerId}`,
		RUNTIME_PROVIDER_CONFLICT_LIMIT,
	);
}

const RUNTIME_SERVICE_WITHDRAWAL_LIMIT = 8;
const runtimeServiceWithdrawalSchema = z
	.object({
		runtime: z.enum(["hermes", "openclaw"]),
		service: z.enum(["dashboard"]),
	})
	.strict();
export type RuntimeServiceWithdrawal = z.infer<typeof runtimeServiceWithdrawalSchema>;

export function runtimeServiceWithdrawals(
	entries: readonly { runtime: string; service: string }[],
): RuntimeServiceWithdrawal[] {
	return canonicalRuntimeEntries(
		runtimeServiceWithdrawalSchema,
		entries,
		(entry) => `${entry.runtime}\0${entry.service}`,
		RUNTIME_SERVICE_WITHDRAWAL_LIMIT,
	);
}

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
		activated: activatedSystemdUnitsSchema,
		officialServiceCommandRevisions: officialServiceCommandRevisionsSchema.optional(),
		providerIds: providerIdsSchema,
		projectedProviderIds: projectedProviderIdsSchema,
		skillEvidence: z.array(hostedSkillEvidenceSchema).optional(),
		nativeCredentialProviderIds: projectedProviderIdsSchema.optional(),
		providerConflicts: z
			.array(runtimeProviderConflictSchema)
			.min(1)
			.max(RUNTIME_PROVIDER_CONFLICT_LIMIT)
			.refine(
				(entries) =>
					runtimeContentSha256(runtimeProviderConflicts(entries)) === runtimeContentSha256(entries),
				{ message: "provider conflicts must be unique and sorted" },
			)
			.optional(),
		serviceWithdrawals: z
			.array(runtimeServiceWithdrawalSchema)
			.min(1)
			.max(RUNTIME_SERVICE_WITHDRAWAL_LIMIT)
			.refine(
				(entries) =>
					runtimeContentSha256(runtimeServiceWithdrawals(entries)) ===
					runtimeContentSha256(entries),
				{ message: "service withdrawals must be unique and sorted" },
			)
			.optional(),
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
	let content: string;
	try {
		content = readFileSync(paths.appliedState, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return runtimeAppliedStateSchema.parse(JSON.parse(content) as unknown);
	} catch (error) {
		log.warn("runtime.applied_state_invalid", {
			path: paths.appliedState,
			error: toErrorMessage(error),
		});
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
			durable: paths.mode === "hosted",
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
