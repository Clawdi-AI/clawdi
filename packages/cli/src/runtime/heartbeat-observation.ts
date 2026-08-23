import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { components } from "@clawdi/shared/api";
import { z } from "zod";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../lib/private-file";
import { log, toErrorMessage } from "../serve/log";
import {
	type RuntimeAppliedState,
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
} from "./applied-state";
import {
	type RuntimeApplyIdentity,
	runtimeApplyIdentitiesEqual,
	runtimeApplyIdentitySchema,
} from "./apply-identity";
import { assertRuntimeBundleAuthority } from "./manifest-source";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths, type RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const isoTimestampSchema = z.string().datetime({ offset: true });

export type HostedRuntimeObservedEvent = components["schemas"]["RuntimeObservationEventV2"] & {
	generation: number;
	manifestETag: string;
};

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
		schemaVersion: z.literal("clawdi.runtimeHeartbeatObservation.v2"),
		environmentId: z.string().min(1),
		bootIdentity: persistedBootIdentitySchema,
		successorBootSessionId: z.string().min(1).max(128),
		predecessorBootSessionId: z.string().min(1).max(128).nullable(),
		phase: z.enum(["preparing-successor", "unestablished", "active"]),
		nextSequence: positiveSafeIntegerSchema,
		lastCapturedAt: isoTimestampSchema.nullable().optional(),
		pending: pendingEventSchema.nullable(),
	})
	.strict()
	.superRefine((state, ctx) => {
		if (state.successorBootSessionId === state.bootIdentity.bootSessionId) {
			ctx.addIssue({
				code: "custom",
				message: "successor boot session must differ from the current boot session",
				path: ["successorBootSessionId"],
			});
		}
		if (state.predecessorBootSessionId === state.bootIdentity.bootSessionId) {
			ctx.addIssue({
				code: "custom",
				message: "predecessor boot session must differ from the current boot session",
				path: ["predecessorBootSessionId"],
			});
		}
	});

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
	createSuccessorId?: () => string;
}

export class HostedRuntimeHeartbeatSession {
	private state: PersistedHeartbeatState | null;
	private readonly statePath: string;
	private readonly paths: RuntimePaths;
	private readonly environmentId: string;
	private capturedAppliedState: RuntimeAppliedState | null = null;
	private currentBootIdentity: PersistedBootIdentity | null = null;
	private readonly now: () => Date;
	private readonly createId: () => string;
	private readonly createSuccessorId: () => string;

	constructor(options: HostedRuntimeHeartbeatOptions) {
		this.paths = options.paths ?? getRuntimePaths();
		this.environmentId = options.environmentId;
		this.now = options.now ?? (() => new Date());
		this.createId = options.createId ?? randomUUID;
		this.createSuccessorId = options.createSuccessorId ?? randomUUID;
		this.statePath = runtimeHeartbeatObservationStatePath(this.paths, options.environmentId);
		const persisted =
			this.paths.mode === "hosted" ? readState(this.statePath, options.environmentId) : null;
		this.state = null;
		this.initializeAppliedState(persisted);
	}

	refreshAppliedState(): boolean {
		const appliedState = this.paths.mode === "hosted" ? readRuntimeAppliedState(this.paths) : null;
		const applyIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (!appliedState || !applyIdentity) {
			this.capturedAppliedState = null;
			this.currentBootIdentity = null;
			return false;
		}
		if (
			this.currentBootIdentity &&
			runtimeApplyIdentitiesEqual(this.currentBootIdentity, applyIdentity)
		) {
			this.capturedAppliedState = appliedState;
			return false;
		}

		const candidate = this.freshState(applyIdentity);
		writeState(this.paths, this.statePath, candidate);
		this.state = candidate;
		this.capturedAppliedState = appliedState;
		this.currentBootIdentity = candidate.bootIdentity;
		return true;
	}

	private initializeAppliedState(persisted: PersistedHeartbeatState | null): void {
		const appliedState = this.paths.mode === "hosted" ? readRuntimeAppliedState(this.paths) : null;
		const applyIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (!appliedState || !applyIdentity) return;

		let candidate: PersistedHeartbeatState;
		if (persisted && runtimeApplyIdentitiesEqual(persisted.bootIdentity, applyIdentity)) {
			if (persisted.phase === "active") {
				candidate = this.rotateState(persisted);
			} else {
				candidate = persisted;
			}
		} else {
			candidate = this.freshState(applyIdentity);
		}
		writeState(this.paths, this.statePath, candidate);
		this.state = candidate;
		this.capturedAppliedState = appliedState;
		this.currentBootIdentity = candidate.bootIdentity;
	}

	private freshState(applyIdentity: RuntimeApplyIdentity): PersistedHeartbeatState {
		const bootSessionId = nonEmptyId(this.createId(), "boot session ID");
		return {
			schemaVersion: "clawdi.runtimeHeartbeatObservation.v2",
			environmentId: this.environmentId,
			bootIdentity: {
				...applyIdentity,
				bootSessionId,
			},
			successorBootSessionId: this.newSuccessorId(bootSessionId),
			predecessorBootSessionId: null,
			phase: "unestablished",
			nextSequence: 1,
			lastCapturedAt: null,
			pending: null,
		};
	}

	private rotateState(state: PersistedHeartbeatState): PersistedHeartbeatState {
		return {
			...state,
			bootIdentity: {
				...state.bootIdentity,
				bootSessionId: state.successorBootSessionId,
			},
			successorBootSessionId: this.newSuccessorId(state.successorBootSessionId),
			predecessorBootSessionId: state.bootIdentity.bootSessionId,
			phase: "unestablished",
			nextSequence: 1,
			pending: state.pending,
		};
	}

	private newSuccessorId(currentBootSessionId: string): string {
		const successor = nonEmptyId(this.createSuccessorId(), "successor boot session ID");
		if (successor === currentBootSessionId) {
			throw new Error("successor boot session ID must differ from the current boot session ID");
		}
		return successor;
	}

	nextEvent(): BufferedRuntimeObservedEvent | null {
		if (this.state?.pending) return decodePendingEvent(this.state.pending);
		if (!this.state || !this.currentBootIdentity || !this.capturedAppliedState) return null;
		if (this.state.nextSequence === Number.MAX_SAFE_INTEGER) {
			throw new Error("runtime heartbeat sequence exhausted for this boot session");
		}

		const observedNow = this.now();
		const durableCaptureFloor = this.state.lastCapturedAt
			? new Date(this.state.lastCapturedAt)
			: null;
		const capturedAt = isoNow(
			durableCaptureFloor && observedNow < durableCaptureFloor ? durableCaptureFloor : observedNow,
		);
		const snapshot = readHostedRuntimeObserved(this.paths, {
			reportedAt: capturedAt,
			appliedState: this.capturedAppliedState,
			includeAgentPlugins: true,
		});
		if (!snapshot) return null;
		if (!snapshot.applied) {
			throw new Error("runtime heartbeat snapshot is missing captured applied state");
		}
		if (
			snapshot.applied.generation !== this.currentBootIdentity.generation ||
			snapshot.applied.etag !== this.capturedAppliedState.etag ||
			snapshot.applied.sourceRevision !== this.capturedAppliedState.sourceRevision
		) {
			throw new Error("runtime heartbeat snapshot does not match captured applied state");
		}
		assertRuntimeBundleAuthority(snapshot.applied.sourceRevision, snapshot.applied.etag);
		const event: HostedRuntimeObservedEvent = {
			...snapshot,
			applied: snapshot.applied,
			generation: this.currentBootIdentity.generation,
			manifestETag: this.currentBootIdentity.manifestETag,
			applyReceiptId: this.currentBootIdentity.applyReceiptId,
			bootNonce: this.currentBootIdentity.bootNonce,
			bootSessionId: this.currentBootIdentity.bootSessionId,
			successorBootSessionId: this.state.successorBootSessionId,
			...(this.state.predecessorBootSessionId
				? { predecessorBootSessionId: this.state.predecessorBootSessionId }
				: {}),
			sequence: this.state.nextSequence,
			eventId: nonEmptyId(this.createId(), "runtime heartbeat event ID"),
			capturedAt,
		};
		const payloadJson = JSON.stringify(event);
		const pending = {
			payloadJson,
			payloadSha256: sha256(payloadJson),
		};
		const candidate = {
			...this.state,
			nextSequence: this.state.nextSequence + 1,
			lastCapturedAt: capturedAt,
			pending,
		};
		writeState(this.paths, this.statePath, candidate);
		this.state = candidate;
		return decodePendingEvent(pending);
	}

	acknowledge(eventId: string): boolean {
		if (!this.state?.pending) return false;
		const pending = decodePendingEvent(this.state.pending);
		if (pending.event.eventId !== eventId) return false;
		let candidate: PersistedHeartbeatState = { ...this.state, pending: null };
		if (
			candidate.phase === "preparing-successor" &&
			pending.event.successorBootSessionId === candidate.successorBootSessionId
		) {
			candidate = this.rotateState(candidate);
		} else if (
			candidate.phase === "unestablished" &&
			pending.event.bootSessionId === candidate.bootIdentity.bootSessionId
		) {
			candidate = { ...candidate, predecessorBootSessionId: null, phase: "active" };
		}
		writeState(this.paths, this.statePath, candidate);
		this.state = candidate;
		this.currentBootIdentity = candidate.bootIdentity;
		return true;
	}

	retireRejected(eventId: string): boolean {
		return this.clearPending(eventId);
	}

	private clearPending(eventId: string): boolean {
		if (!this.state?.pending) return false;
		const pending = decodePendingEvent(this.state.pending);
		if (pending.event.eventId !== eventId) return false;
		const candidate = { ...this.state, pending: null };
		writeState(this.paths, this.statePath, candidate);
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

function readState(path: string, environmentId: string): PersistedHeartbeatState | null {
	let serialized: string;
	try {
		serialized = readFileSync(path, "utf-8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return null;
		throw new Error(
			`unable to read durable runtime heartbeat state at ${path}: ${toErrorMessage(error)}`,
		);
	}

	try {
		const raw: unknown = JSON.parse(serialized);
		const state = heartbeatStateSchema.parse(raw);
		if (state.environmentId !== environmentId) {
			throw new Error("runtime heartbeat state environment binding does not match");
		}
		if (state.pending) decodePendingEvent(state.pending);
		return state;
	} catch (error) {
		const quarantinePath = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
		try {
			renameSync(path, quarantinePath);
		} catch (quarantineError) {
			throw new Error(
				`invalid durable runtime heartbeat state at ${path}: ${toErrorMessage(
					error,
				)}; quarantine failed: ${toErrorMessage(quarantineError)}`,
			);
		}
		log.warn("daemon.runtime_heartbeat_state_quarantined", {
			path,
			quarantine_path: quarantinePath,
			error: error instanceof z.ZodError ? "state schema validation failed" : toErrorMessage(error),
		});
		return null;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function writeState(paths: RuntimePaths, path: string, state: PersistedHeartbeatState): void {
	const parsed = heartbeatStateSchema.parse(state);
	writeRuntimePlatformFileAtomic(paths, path, `${JSON.stringify(parsed, null, 2)}\n`, {
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
	let event: HostedRuntimeObservedEvent;
	try {
		event = JSON.parse(pending.payloadJson);
	} catch (error) {
		throw new Error(
			`durable runtime heartbeat event payload is invalid JSON: ${toErrorMessage(error)}`,
		);
	}
	return {
		event,
		payloadJson: pending.payloadJson,
		payloadSha256: pending.payloadSha256,
	};
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
