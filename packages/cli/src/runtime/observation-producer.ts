import { readFileSync } from "node:fs";
import { z } from "zod";
import { ApiClient, unwrap } from "../lib/api-client";
import { log, toErrorMessage } from "../serve/log";
import { readRuntimeAppliedState, runtimeAppliedApplyIdentity } from "./applied-state";
import { type RuntimeApplyIdentity, readRuntimeApplyIdentityFromEnv } from "./apply-identity";
import {
	HostedRuntimeHeartbeatSession,
	type HostedRuntimeObservedEvent,
} from "./heartbeat-observation";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const OBSERVATION_INTERVAL_MS = 60_000;
const IDLE_RETRY_INTERVAL_MS = 1_000;

const runtimeInstanceIdentitySchema = z
	.object({
		schemaVersion: z.literal("clawdi.runtimeInstanceData.v1"),
		environmentId: z.string().min(1).max(200),
	})
	.passthrough();

type ObservationSubmitResult = "accepted" | "terminal-stale";

interface RuntimeObservationProducerOptions {
	abort: AbortSignal;
	paths?: RuntimePaths;
	submit?: (
		environmentId: string,
		event: HostedRuntimeObservedEvent,
	) => Promise<ObservationSubmitResult>;
	sessionFactory?: (environmentId: string, paths: RuntimePaths) => HostedRuntimeHeartbeatSession;
	delay?: (ms: number, abort: AbortSignal) => Promise<void>;
}

interface AttestedRuntimeObservationContext {
	environmentId: string;
	expectedApplyIdentity: RuntimeApplyIdentity;
	identityKey: string;
}

export class HostedRuntimeObservationProducer {
	private readonly paths: RuntimePaths;
	private readonly submit: NonNullable<RuntimeObservationProducerOptions["submit"]>;
	private readonly sessionFactory: NonNullable<RuntimeObservationProducerOptions["sessionFactory"]>;
	private session: HostedRuntimeHeartbeatSession | null = null;
	private environmentId: string | null = null;

	constructor(options: RuntimeObservationProducerOptions) {
		this.paths = options.paths ?? getRuntimePaths();
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
				if (isSafelyTerminalRuntimeObservationFailure(response)) return "terminal-stale";
				unwrap(response);
				return "accepted";
			};
		}
	}

	async sendOnce(): Promise<"idle" | "sent" | "failed"> {
		let buffered: ReturnType<HostedRuntimeHeartbeatSession["nextEvent"]> = null;
		try {
			const context = this.readAttestedContext();
			if (!context) return "idle";
			const { environmentId, expectedApplyIdentity } = context;
			if (!this.session || this.environmentId !== environmentId) {
				this.session = this.sessionFactory(environmentId, this.paths);
				this.environmentId = environmentId;
			} else {
				this.session.refreshAppliedState();
			}

			buffered = this.session.nextEvent();
			if (!buffered) return "idle";
			if (!eventMatchesApplyIdentity(buffered.event, expectedApplyIdentity)) {
				return "idle";
			}
			const result = await this.submit(environmentId, buffered.event);
			if (this.currentAttestedIdentityKey() !== context.identityKey) {
				return "sent";
			}
			if (result === "terminal-stale") {
				if (!this.session.retireTerminallyStale(buffered.event.eventId)) {
					throw new Error("terminally stale runtime observation did not match buffered event");
				}
				log.warn("daemon.runtime_observation_retired_stale", {
					event_id: buffered.event.eventId,
					captured_at: buffered.event.capturedAt,
				});
				return "sent";
			}
			if (!this.session.acknowledge(buffered.event.eventId)) {
				throw new Error("runtime observation acknowledgement did not match buffered event");
			}
			return "sent";
		} catch (error) {
			log.info("daemon.runtime_observation_failed", {
				error: toErrorMessage(error),
				...(buffered ? { event_id: buffered.event.eventId } : {}),
			});
			return "failed";
		}
	}

	currentAttestedIdentityKey(): string | null {
		return this.readAttestedContext()?.identityKey ?? null;
	}

	private readAttestedContext(): AttestedRuntimeObservationContext | null {
		const expectedApplyIdentity = readRuntimeApplyIdentityFromEnv();
		if (!expectedApplyIdentity) return null;
		const appliedState = readRuntimeAppliedState(this.paths);
		const appliedIdentity = appliedState ? runtimeAppliedApplyIdentity(appliedState) : null;
		if (!appliedIdentity || !sameApplyIdentity(appliedIdentity, expectedApplyIdentity)) {
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
	const activeAttempts = new Map<string, Promise<void>>();
	const nextAttemptAt = new Map<string, number>();
	while (!options.abort.aborted) {
		try {
			const identityKey = producer.currentAttestedIdentityKey();
			if (
				identityKey &&
				!activeAttempts.has(identityKey) &&
				Date.now() >= (nextAttemptAt.get(identityKey) ?? 0)
			) {
				const attempt = producer.sendOnce().then((result) => {
					nextAttemptAt.set(
						identityKey,
						Date.now() + (result === "idle" ? IDLE_RETRY_INTERVAL_MS : OBSERVATION_INTERVAL_MS),
					);
					activeAttempts.delete(identityKey);
				});
				activeAttempts.set(identityKey, attempt);
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

function sameApplyIdentity(left: RuntimeApplyIdentity, right: RuntimeApplyIdentity): boolean {
	return (
		left.generation === right.generation &&
		left.manifestETag === right.manifestETag &&
		left.applyReceiptId === right.applyReceiptId &&
		left.bootNonce === right.bootNonce
	);
}

function eventMatchesApplyIdentity(
	event: HostedRuntimeObservedEvent,
	identity: RuntimeApplyIdentity,
): boolean {
	return (
		event.applied.generation === identity.generation &&
		event.applied.etag === identity.manifestETag &&
		event.applyReceiptId === identity.applyReceiptId &&
		event.bootNonce === identity.bootNonce
	);
}

export function isSafelyTerminalRuntimeObservationFailure(result: {
	error?: unknown;
	response: { status: number };
}): boolean {
	if (result.response.status !== 422 || !isUnknownRecord(result.error)) return false;
	const detail = result.error.detail;
	return isUnknownRecord(detail) && detail.code === "runtime_observation_captured_at_too_old";
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
