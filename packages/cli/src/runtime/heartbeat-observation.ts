import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import {
	type RuntimeAppliedState,
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
} from "./applied-state";
import { runtimeApplyIdentitySchema } from "./apply-identity";
import { type HostedRuntimeObserved, readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoTimestampSchema = z.string().datetime({ offset: true });

const observedAppliedSchema = z
	.object({
		etag: z.string(),
		sourceRevision: z.string(),
		generation: z.number().int().nonnegative(),
		instanceId: z.string(),
		appliedProviderIds: z.array(z.string()),
	})
	.strict();

const observedBootSchema = z
	.object({
		status: z.enum(["ok", "error", "unknown"]),
		mode: z.string(),
		stage: z.string(),
		timestamp: z.string(),
		activeGeneration: z.number().int().nonnegative().nullable().optional(),
		instanceId: z.string().nullable().optional(),
		enabledRuntimes: z.array(z.string()),
		errors: z.array(z.string()),
	})
	.strict();

const observedCliSchema = z
	.object({
		status: z.string().nullable().optional(),
		source: z.string().nullable().optional(),
		packageSpec: z.string().nullable().optional(),
		registry: z.string().nullable().optional(),
		activePath: z.string().nullable().optional(),
		activeTarget: z.string().nullable().optional(),
		version: z.string().nullable().optional(),
	})
	.strict();

const observedSystemdUnitSchema = z
	.object({
		scope: z.enum(["system", "user"]),
		name: z.string(),
		activeState: z.string(),
		subState: z.string(),
		status: z.enum(["ok", "error", "unknown"]),
		error: z.string().nullable().optional(),
	})
	.strict();

const observedSystemdSchema = z
	.object({
		status: z.enum(["ok", "error", "unknown"]),
		unitCount: z.number().int().nonnegative(),
		units: z.array(observedSystemdUnitSchema),
	})
	.strict();

const observedSupervisorProgramSchema = z
	.object({
		name: z.string(),
		state: z.string(),
		status: z.enum(["ok", "error", "unknown"]),
		description: z.string().nullable().optional(),
	})
	.strict();

const observedSupervisorSchema = z
	.object({
		status: z.enum(["ok", "error", "unknown"]),
		programs: z.array(observedSupervisorProgramSchema),
	})
	.strict();

export type HostedRuntimeObservedEvent = HostedRuntimeObserved & {
	applyReceiptId: string;
	bootNonce: string;
	bootSessionId: string;
	sequence: number;
	eventId: string;
	capturedAt: string;
};

const hostedRuntimeObservedEventSchema: z.ZodType<HostedRuntimeObservedEvent> = z
	.object({
		schemaVersion: z.literal("clawdi.hostedRuntimeObserved.v2"),
		reportedAt: isoTimestampSchema,
		runtimeMode: z.literal("hosted"),
		status: z.enum(["ok", "error", "unknown"]),
		activeCliVersion: z.string().nullable(),
		applied: observedAppliedSchema,
		boot: observedBootSchema.nullable(),
		cli: observedCliSchema.nullable(),
		systemd: observedSystemdSchema.nullable().optional(),
		supervisor: observedSupervisorSchema.nullable().optional(),
		providers: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
		error: z.string().nullable().optional(),
		convergeError: z.string().nullable().optional(),
		truncated: z.boolean().nullable().optional(),
		applyReceiptId: z.string().min(16).max(128),
		bootNonce: z.string().min(16).max(128),
		bootSessionId: z.string().min(1).max(128),
		sequence: positiveSafeIntegerSchema,
		eventId: z.string().min(1).max(128),
		capturedAt: isoTimestampSchema,
	})
	.strict()
	.superRefine((event, ctx) => {
		if (event.reportedAt !== event.capturedAt) {
			ctx.addIssue({
				code: "custom",
				message: "reportedAt must equal the original capturedAt for companion events",
				path: ["reportedAt"],
			});
		}
	});

const persistedBootIdentitySchema = runtimeApplyIdentitySchema
	.safeExtend({
		bootSessionId: z.string().min(1).max(128),
	})
	.strict();

const pendingEventSchema = z
	.object({
		payloadJson: z.string().min(1),
		payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();

const heartbeatStateSchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeHeartbeatObservation.v1"),
		environmentId: z.string().min(1),
		bootIdentity: persistedBootIdentitySchema,
		nextSequence: positiveSafeIntegerSchema,
		pending: pendingEventSchema.nullable(),
	})
	.strict();

type PersistedHeartbeatState = z.infer<typeof heartbeatStateSchema>;
type PersistedBootIdentity = z.infer<typeof persistedBootIdentitySchema>;

export interface BufferedRuntimeObservedEvent {
	event: HostedRuntimeObservedEvent;
	payloadJson: string;
	payloadSha256: string;
}

interface HostedRuntimeHeartbeatOptions {
	environmentId: string;
	paths?: RuntimePaths;
	now?: () => Date;
	createId?: () => string;
}

export class HostedRuntimeHeartbeatSession {
	private state: PersistedHeartbeatState | null;
	private readonly statePath: string;
	private readonly paths: RuntimePaths;
	private readonly capturedAppliedState: RuntimeAppliedState | null;
	private readonly currentBootIdentity: PersistedBootIdentity | null;
	private readonly now: () => Date;
	private readonly createId: () => string;

	constructor(options: HostedRuntimeHeartbeatOptions) {
		this.paths = options.paths ?? getRuntimePaths();
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? randomUUID;
		this.statePath = runtimeHeartbeatObservationStatePath(this.paths, options.environmentId);
		this.state = this.paths.mode === "hosted" ? readState(this.statePath) : null;
		if (this.state && this.state.environmentId !== options.environmentId) {
			throw new Error("runtime heartbeat state environment binding does not match");
		}

		this.capturedAppliedState =
			this.paths.mode === "hosted" ? readRuntimeAppliedState(this.paths) : null;
		const applyIdentity = this.capturedAppliedState
			? runtimeAppliedApplyIdentity(this.capturedAppliedState)
			: null;
		if (!applyIdentity) {
			this.currentBootIdentity = null;
			return;
		}

		this.currentBootIdentity = {
			...applyIdentity,
			bootSessionId: nonEmptyId(this.createId(), "boot session ID"),
		};
		this.state = {
			schemaVersion: "clawdi.runtimeHeartbeatObservation.v1",
			environmentId: options.environmentId,
			bootIdentity: this.currentBootIdentity,
			nextSequence: 1,
			pending: this.state?.pending ?? null,
		};
		writeState(this.statePath, this.state);
	}

	nextEvent(): BufferedRuntimeObservedEvent | null {
		if (this.state?.pending) return decodePendingEvent(this.state.pending);
		if (!this.state || !this.currentBootIdentity || !this.capturedAppliedState) return null;
		if (this.state.nextSequence === Number.MAX_SAFE_INTEGER) {
			throw new Error("runtime heartbeat sequence exhausted for this boot session");
		}

		const capturedAt = isoNow(this.now());
		const snapshot = readHostedRuntimeObserved(this.paths, {
			reportedAt: capturedAt,
			appliedState: this.capturedAppliedState,
		});
		if (!snapshot) return null;
		const event: HostedRuntimeObservedEvent = {
			...snapshot,
			applyReceiptId: this.currentBootIdentity.applyReceiptId,
			bootNonce: this.currentBootIdentity.bootNonce,
			bootSessionId: this.currentBootIdentity.bootSessionId,
			sequence: this.state.nextSequence,
			eventId: nonEmptyId(this.createId(), "runtime heartbeat event ID"),
			capturedAt,
		};
		const payloadJson = serializeObservedEvent(event);
		const pending = {
			payloadJson,
			payloadSha256: sha256(payloadJson),
		};
		const candidate = {
			...this.state,
			nextSequence: this.state.nextSequence + 1,
			pending,
		};
		writeState(this.statePath, candidate);
		this.state = candidate;
		return decodePendingEvent(pending);
	}

	acknowledge(eventId: string): boolean {
		if (!this.state?.pending) return false;
		const pending = decodePendingEvent(this.state.pending);
		if (pending.event.eventId !== eventId) return false;
		const candidate = { ...this.state, pending: null };
		writeState(this.statePath, candidate);
		this.state = candidate;
		return true;
	}

	get hasCompanionIdentity(): boolean {
		return this.currentBootIdentity !== null;
	}
}

export function runtimeHeartbeatObservationStatePath(
	paths: RuntimePaths,
	environmentId: string,
): string {
	const environmentKey = createHash("sha256").update(environmentId).digest("hex");
	return join(paths.runtimeHeartbeatRoot, `${environmentKey}.json`);
}

function readState(path: string): PersistedHeartbeatState | null {
	if (!existsSync(path)) return null;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return heartbeatStateSchema.parse(raw);
	} catch (error) {
		throw new Error(
			`invalid durable runtime heartbeat state at ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function writeState(path: string, state: PersistedHeartbeatState): void {
	const parsed = heartbeatStateSchema.parse(state);
	writePrivateFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`, {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
}

function decodePendingEvent(
	pending: z.infer<typeof pendingEventSchema>,
): BufferedRuntimeObservedEvent {
	if (sha256(pending.payloadJson) !== pending.payloadSha256) {
		throw new Error("durable runtime heartbeat event payload hash does not match");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(pending.payloadJson);
	} catch (error) {
		throw new Error(
			`durable runtime heartbeat event payload is invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return {
		event: hostedRuntimeObservedEventSchema.parse(raw),
		payloadJson: pending.payloadJson,
		payloadSha256: pending.payloadSha256,
	};
}

function serializeObservedEvent(event: HostedRuntimeObservedEvent): string {
	return JSON.stringify(hostedRuntimeObservedEventSchema.parse(event));
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function isoNow(value: Date): string {
	if (!Number.isFinite(value.getTime()))
		throw new Error("runtime heartbeat clock returned invalid time");
	return value.toISOString();
}

function nonEmptyId(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${name} must not be empty`);
	return normalized;
}
