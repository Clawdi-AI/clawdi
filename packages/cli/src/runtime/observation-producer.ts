import { readFileSync } from "node:fs";
import { ApiClient, unwrap } from "../lib/api-client";
import { log, toErrorMessage } from "../serve/log";
import { readRuntimeAppliedState, runtimeAppliedApplyIdentity } from "./applied-state";
import {
	type RuntimeApplyIdentity,
	readRuntimeApplyContext,
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
const FAILURE_RETRY_INTERVAL_MS = 5_000;

type ObservationSubmitResult = "accepted" | "terminal-rejected";
type RuntimeObservedStatus = HostedRuntimeObservedEvent["status"];

type ObservationSendResult =
	| { outcome: "idle" }
	| { outcome: "sent" }
	| { outcome: "failed" }
	| { outcome: "accepted"; status: RuntimeObservedStatus; capturedAt: string };

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
	consecutiveFailures: number;
	convergenceWindowEnd: number | "closed" | null;
	lastAttemptedAppliedReceipt: string | null;
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
			return {
				outcome: "accepted",
				status: buffered.event.status,
				capturedAt: buffered.event.capturedAt,
			};
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
		const runtimeContext = readRuntimeApplyContext(this.contextPath);
		const expectedApplyIdentity = runtimeContext.identity;
		const appliedState = readRuntimeAppliedState(this.paths);
		const appliedIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (!runtimeApplyIdentitiesEqual(appliedIdentity, expectedApplyIdentity)) {
			return null;
		}
		const environmentId = process.env.CLAWDI_ENVIRONMENT_ID;
		if (environmentId === undefined) return null;
		if (!environmentId || environmentId !== environmentId.trim()) {
			throw new Error("CLAWDI_ENVIRONMENT_ID must be a non-empty canonical identity");
		}
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
				const appliedReceipt = readRuntimeWatchAppliedReceipt(paths);
				const schedule = schedules.get(identityKey) ?? {
					nextAttemptAt: 0,
					consecutiveFailures: 0,
					convergenceWindowEnd: null,
					lastAttemptedAppliedReceipt: null,
				};
				schedules.set(identityKey, schedule);
				if (
					now() >= schedule.nextAttemptAt ||
					(appliedReceipt !== null && appliedReceipt !== schedule.lastAttemptedAppliedReceipt)
				) {
					schedule.lastAttemptedAppliedReceipt = appliedReceipt;
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
							// A retried event retains its capture time; acknowledging it must not
							// postpone the next fresh sample by another full interval.
							interval = Math.max(
								IDLE_RETRY_INTERVAL_MS,
								interval - Math.max(0, completedAt - Date.parse(result.capturedAt)),
							);
						}
						if (result.outcome === "failed") {
							schedule.consecutiveFailures = Math.min(schedule.consecutiveFailures + 1, 5);
							interval = Math.min(
								OBSERVATION_INTERVAL_MS,
								FAILURE_RETRY_INTERVAL_MS * 2 ** (schedule.consecutiveFailures - 1),
							);
						} else {
							schedule.consecutiveFailures = 0;
						}
						if (result.outcome === "idle") {
							interval = IDLE_RETRY_INTERVAL_MS;
						}
						schedule.nextAttemptAt = completedAt + interval;
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

function readRuntimeWatchAppliedReceipt(paths: RuntimePaths): string | null {
	let content: string;
	try {
		content = readFileSync(paths.runtimeWatchStatus, "utf-8");
	} catch {
		return null;
	}
	try {
		const status: unknown = JSON.parse(content);
		if (!isUnknownRecord(status) || !isUnknownRecord(status.event)) return null;
		return status.event.status === "applied" ? content : null;
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
