import { readFileSync } from "node:fs";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { log, toErrorMessage } from "../serve/log";
import { readRuntimeAppliedState, runtimeAppliedApplyIdentity } from "./applied-state";
import {
	type RuntimeApplyIdentity,
	readRuntimeApplyIdentity,
	runtimeApplyIdentitiesEqual,
} from "./apply-identity";
import {
	HostedRuntimeHeartbeatSession,
	type HostedRuntimeObservedEvent,
} from "./heartbeat-observation";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const OBSERVATION_INTERVAL_MS = 60_000;
const CONVERGENCE_OBSERVATION_INTERVAL_MS = 5_000;
const CONVERGENCE_OBSERVATION_WINDOW_MS = 90_000;
const IDLE_RETRY_INTERVAL_MS = 1_000;

const runtimeInstanceIdentitySchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeInstanceData.v1"),
		environmentId: z.string().min(1).max(200),
	})
	.passthrough();

type ObservationSubmitResult = "accepted" | "terminal-rejected";
type RuntimeObservedStatus = HostedRuntimeObservedEvent["status"];

type ObservationSendResult =
	| { outcome: "idle" }
	| { outcome: "sent" }
	| { outcome: "failed" }
	| { outcome: "accepted"; status: RuntimeObservedStatus };

interface RuntimeObservationProducerOptions {
	abort: AbortSignal;
	paths?: RuntimePaths;
	contextPath?: string;
	submit?: (
		environmentId: string,
		event: HostedRuntimeObservedEvent,
	) => Promise<ObservationSubmitResult>;
	sessionFactory?: (environmentId: string, paths: RuntimePaths) => HostedRuntimeHeartbeatSession;
	delay?: (ms: number, abort: AbortSignal) => Promise<void>;
	now?: () => number;
}

interface AttestedRuntimeObservationContext {
	environmentId: string;
	expectedApplyIdentity: RuntimeApplyIdentity;
	identityKey: string;
}

interface ObservationSchedule {
	nextAttemptAt: number;
	convergenceWindowEnd: number | "closed" | null;
}

export class HostedRuntimeObservationProducer {
	private readonly paths: RuntimePaths;
	private readonly contextPath: string | undefined;
	private readonly submit: NonNullable<RuntimeObservationProducerOptions["submit"]>;
	private readonly sessionFactory: NonNullable<RuntimeObservationProducerOptions["sessionFactory"]>;
	private session: HostedRuntimeHeartbeatSession | null = null;
	private environmentId: string | null = null;
	private lastAttestationError: string | null = null;

	constructor(options: RuntimeObservationProducerOptions) {
		this.paths = options.paths ?? getRuntimePaths();
		this.contextPath = options.contextPath;
		this.sessionFactory =
			options.sessionFactory ??
			((environmentId, paths) => new HostedRuntimeHeartbeatSession({ environmentId, paths }));
		if (options.submit) {
			this.submit = options.submit;
		} else {
			const api = new ApiClient({ abortSignal: options.abort });
			this.submit = async (environmentId, event) => {
				const response = await api.POST("/v2/runtime/environments/{environment_id}/observations", {
					params: { path: { environment_id: environmentId } },
					body: event,
				});
				if (isPermanentRuntimeObservationRejection(response)) return "terminal-rejected";
				unwrap(response);
				return "accepted";
			};
		}
	}

	async sendOnce(): Promise<ObservationSendResult> {
		let buffered: ReturnType<HostedRuntimeHeartbeatSession["nextEvent"]> = null;
		try {
			const context = this.readAttestedContext();
			if (!context) return { outcome: "idle" };
			const { environmentId, expectedApplyIdentity } = context;
			if (!this.session || this.environmentId !== environmentId) {
				this.session = this.sessionFactory(environmentId, this.paths);
				this.environmentId = environmentId;
			} else {
				this.session.refreshAppliedState();
			}

			buffered = this.session.nextEvent();
			if (!buffered) return { outcome: "idle" };
			if (!runtimeApplyIdentitiesEqual(buffered.event, expectedApplyIdentity)) {
				return { outcome: "idle" };
			}
			const result = await this.submit(environmentId, buffered.event);
			if (this.currentAttestedIdentityKey() !== context.identityKey) {
				return { outcome: "sent" };
			}
			if (result === "terminal-rejected") {
				if (!this.session.retireRejected(buffered.event.eventId)) {
					throw new Error("rejected runtime observation did not match buffered event");
				}
				log.warn("daemon.runtime_observation_retired_rejected", {
					event_id: buffered.event.eventId,
					captured_at: buffered.event.capturedAt,
				});
				return { outcome: "sent" };
			}
			if (!this.session.acknowledge(buffered.event.eventId)) {
				throw new Error("runtime observation acknowledgement did not match buffered event");
			}
			return { outcome: "accepted", status: buffered.event.status };
		} catch (error) {
			log.info("daemon.runtime_observation_failed", {
				error: toErrorMessage(error),
				...(buffered ? { event_id: buffered.event.eventId } : {}),
			});
			return { outcome: "failed" };
		}
	}

	currentAttestedIdentityKey(): string | null {
		try {
			const identityKey = this.readAttestedContext()?.identityKey ?? null;
			this.lastAttestationError = null;
			return identityKey;
		} catch (error) {
			const message = toErrorMessage(error);
			if (message !== this.lastAttestationError) {
				log.warn("daemon.runtime_observation_attestation_invalid", { error: message });
				this.lastAttestationError = message;
			}
			return null;
		}
	}

	private readAttestedContext(): AttestedRuntimeObservationContext | null {
		const expectedApplyIdentity = readRuntimeApplyIdentity(this.contextPath);
		const appliedState = readRuntimeAppliedState(this.paths);
		const appliedIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (!runtimeApplyIdentitiesEqual(appliedIdentity, expectedApplyIdentity)) {
			return null;
		}
		const environmentId = readRuntimeObservationEnvironmentId(this.paths);
		if (!environmentId) return null;
		return {
			environmentId,
			expectedApplyIdentity,
			identityKey: JSON.stringify([
				environmentId,
				expectedApplyIdentity.generation,
				expectedApplyIdentity.manifestETag,
				expectedApplyIdentity.applyReceiptId,
				expectedApplyIdentity.bootNonce,
			]),
		};
	}
}

export async function runRuntimeObservationProducer(
	options: RuntimeObservationProducerOptions,
): Promise<void> {
	const paths = options.paths ?? getRuntimePaths();
	if (paths.mode !== "hosted") return;
	const producer = new HostedRuntimeObservationProducer({ ...options, paths });
	const delay = options.delay ?? abortableDelay;
	const now = options.now ?? Date.now;
	const activeAttempts = new Map<string, Promise<void>>();
	const schedules = new Map<string, ObservationSchedule>();
	while (!options.abort.aborted) {
		try {
			const identityKey = producer.currentAttestedIdentityKey();
			pruneRetiredIdentityEntries(activeAttempts, identityKey);
			pruneRetiredIdentityEntries(schedules, identityKey);
			if (identityKey && !activeAttempts.has(identityKey)) {
				const schedule = schedules.get(identityKey) ?? {
					nextAttemptAt: 0,
					convergenceWindowEnd: null,
				};
				schedules.set(identityKey, schedule);
				if (now() >= schedule.nextAttemptAt) {
					const attempt = producer.sendOnce().then((result) => {
						const completedAt = now();
						let interval = OBSERVATION_INTERVAL_MS;
						if (result.outcome === "accepted") {
							if (result.status === "ok") {
								schedule.convergenceWindowEnd = "closed";
							} else if (schedule.convergenceWindowEnd !== "closed") {
								schedule.convergenceWindowEnd ??= completedAt + CONVERGENCE_OBSERVATION_WINDOW_MS;
								if (completedAt < schedule.convergenceWindowEnd) {
									interval = Math.min(
										CONVERGENCE_OBSERVATION_INTERVAL_MS,
										schedule.convergenceWindowEnd - completedAt,
									);
								}
							}
						}
						schedule.nextAttemptAt =
							completedAt + (result.outcome === "idle" ? IDLE_RETRY_INTERVAL_MS : interval);
						if (activeAttempts.get(identityKey) === attempt) {
							activeAttempts.delete(identityKey);
						}
					});
					activeAttempts.set(identityKey, attempt);
				}
			}
		} catch (error) {
			log.info("daemon.runtime_observation_failed", { error: toErrorMessage(error) });
		}
		await delay(IDLE_RETRY_INTERVAL_MS, options.abort);
	}
}

export function readRuntimeObservationEnvironmentId(paths: RuntimePaths): string | null {
	const fromEnvironment = process.env.CLAWDI_ENVIRONMENT_ID;
	if (fromEnvironment !== undefined) {
		const normalized = fromEnvironment.trim();
		if (!normalized || normalized !== fromEnvironment) {
			throw new Error("CLAWDI_ENVIRONMENT_ID must be a non-empty canonical identity");
		}
		return normalized;
	}
	try {
		const value: unknown = JSON.parse(readFileSync(paths.instanceData, "utf-8"));
		return runtimeInstanceIdentitySchema.parse(value).environmentId;
	} catch {
		return null;
	}
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafelyTerminalRuntimeObservationFailure(result: {
	error?: unknown;
	response: { status: number };
}): boolean {
	if (result.response.status !== 422 || !isUnknownRecord(result.error)) return false;
	const detail = result.error.detail;
	return isUnknownRecord(detail) && detail.code === "runtime_observation_captured_at_too_old";
}

export function isPermanentRuntimeObservationRejection(result: {
	response: { status: number };
}): boolean {
	return (
		result.response.status >= 400 && result.response.status < 500 && result.response.status !== 429
	);
}

function pruneRetiredIdentityEntries<T>(entries: Map<string, T>, identityKey: string | null): void {
	for (const key of entries.keys()) {
		if (key !== identityKey) entries.delete(key);
	}
}

function abortableDelay(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			abort.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		abort.addEventListener("abort", onAbort, { once: true });
	});
}
