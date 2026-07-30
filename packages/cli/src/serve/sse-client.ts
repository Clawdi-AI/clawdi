/**
 * Outbound SSE consumer for `GET /v1/sync/events`.
 *
 * Why outbound, not webhook: pods don't open inbound HTTP
 * servers (k8s ingress, NAT, no public domain), but they can
 * always *connect out*. SSE over a long-lived HTTPS GET gives us
 * webhook-like push semantics through any firewall.
 *
 * Lifecycle:
 *   1. dial() — open a long-lived response stream
 *   2. parse `event:` / `data:` lines into typed messages
 *   3. yield each event to the caller
 *   4. on stream end / network error: backoff and reconnect
 *   5. on 401: stop forever — deploy-key revoked, no point
 *      retrying (caller exits the daemon)
 *
 * Heartbeat semantics:
 *   - server emits `: ping` SSE comment every 25s
 *   - we treat 60s of silence as "stale" and force a reconnect
 *   - the parser ignores comment lines, but the read deadline
 *     resets on ANY chunk including the `: ping` newline
 *
 * Backoff: 1s → 60s exponential with ±20% jitter. Capped to
 * keep a long outage from drifting into an hour-long retry gap.
 */

import { createParser, type EventSourceMessage } from "eventsource-parser";
import { parseRetryAfter } from "../lib/retry-after";
import {
	SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
	SKILL_SYNC_PROTOCOL_HEADER,
} from "../lib/skill-sync-protocol";
import { log, toErrorMessage } from "./log";

/** Events the server emits. Mirrors `bump_skills_revision` on
 * the backend; widen the union as new event types ship. Keep in
 * sync with `app/services/sync_events.py`.
 *
 * `project_id` carries the project that owns the affected skill —
 * daemons MUST drop events whose project_id doesn't match their
 * Agent Project. Skill events are invalidation hints only: the
 * filesystem-authoritative sync engine re-scans local state and never
 * downloads or deletes local content in response to Cloud events. */
export type SkillServerEvent =
	| {
			type: "skill_changed" | "agent_skill_changed";
			skill_key: string;
			project_id: string;
			skills_revision: number;
			/** Optional projection hash retained for wire compatibility.
			 * It is never authority for local filesystem mutation. */
			content_hash?: string;
	  }
	| {
			type: "skill_deleted" | "agent_skill_deleted";
			skill_key: string;
			project_id: string;
			skills_revision: number;
	  };

type SkillChangedEventType = "skill_changed" | "agent_skill_changed";
type SkillDeletedEventType = "skill_deleted" | "agent_skill_deleted";

function isSkillChangedEventType(value: unknown): value is SkillChangedEventType {
	return value === "skill_changed" || value === "agent_skill_changed";
}

function isSkillDeletedEventType(value: unknown): value is SkillDeletedEventType {
	return value === "skill_deleted" || value === "agent_skill_deleted";
}

export type RuntimeManifestChangedEvent = {
	type: "runtime_manifest_changed";
	environment_id: string;
};

export type ServerEvent = SkillServerEvent | RuntimeManifestChangedEvent;

const STALE_MS = 60_000;
const HEARTBEAT_HINT_MS = 25_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface Opts {
	apiUrl: string;
	apiKey: string;
	/** Refresh-aware provider used by durable OAuth CLI sessions on reconnect. */
	getAccessToken?: () => Promise<string>;
	abort: AbortSignal;
	onEvent: (event: ServerEvent) => void | Promise<void>;
	/** Called when the stream connects. Used by the daemon to
	 * surface "online/offline" in the heartbeat payload. */
	onConnect?: () => void;
	/** Called when the stream drops (network error, server close,
	 * stale read). Daemon flips status to "reconnecting". */
	onDisconnect?: (info: SseReconnectInfo) => void;
	/** Called once on a 401, just before the consumer loop exits.
	 * Daemon shuts down — the deploy-key won't come back. */
	onAuthFailure?: () => void;
}

export type SseReconnectClassification = "transient" | "sustained";

export interface SseReconnectInfo {
	reason: string;
	attempt: number;
	wait_ms: number;
	consecutive_failures: number;
	classification: SseReconnectClassification;
	first_byte_received?: boolean;
	http_status?: number;
	request_id?: string;
}

const TRANSIENT_RECONNECT_FAILURES = 3;

class SseConnectionError extends Error {
	readonly reason: string;
	readonly httpStatus?: number;
	readonly requestId?: string;
	readonly retryAfterMs?: number;

	constructor(
		reason: string,
		fields?: { httpStatus?: number; requestId?: string | null; retryAfterMs?: number | null },
	) {
		super(reason);
		this.name = "SseConnectionError";
		this.reason = reason;
		this.httpStatus = fields?.httpStatus;
		this.requestId = fields?.requestId ?? undefined;
		this.retryAfterMs = fields?.retryAfterMs ?? undefined;
	}
}

// Only reset the backoff counter if the connection survived this
// long. Pre-fix any clean 200-close — including a proxy that
// closes the stream instantly — reset attempt to 0, which made
// the loop hot-reconnect with no delay. With the floor in place,
// a misbehaving upstream still pays exponential backoff.
const STABLE_CONNECTION_MS = 60_000;

export async function consumeSse(opts: Opts): Promise<void> {
	let attempt = 0;
	while (!opts.abort.aborted) {
		// "Stable" means: the stream produced its first byte AND
		// stayed alive for STABLE_CONNECTION_MS after that point.
		// Pre-fix the timer started at fetch dial — a slow TLS
		// handshake plus instant 200-close still counted as "stable"
		// because the elapsed wall-clock crossed the threshold.
		// Tracking `firstByteAt` via a callback gates reset on real
		// readiness, not just dial duration.
		let firstByteAt: number | null = null;
		try {
			await dialAndStream({
				...opts,
				onFirstByte: () => {
					firstByteAt = Date.now();
				},
			});
			if (firstByteAt !== null && Date.now() - firstByteAt >= STABLE_CONNECTION_MS) {
				attempt = 0;
			} else {
				const wait = backoffMs(attempt);
				const info = buildReconnectInfo({
					reason: "unstable_close",
					attempt,
					wait_ms: wait,
					first_byte_received: firstByteAt !== null,
				});
				logReconnect("sse.reconnect_unstable_close", info);
				opts.onDisconnect?.(info);
				attempt += 1;
				await sleep(wait, opts.abort);
			}
		} catch (err) {
			if (opts.abort.aborted) return;
			const error = errorInfo(err);
			if (error.reason === "auth_failed") {
				opts.onAuthFailure?.();
				return;
			}
			const wait = error.retry_after_ms ?? backoffMs(attempt);
			const info = buildReconnectInfo({
				reason: error.reason,
				attempt,
				wait_ms: wait,
				http_status: error.http_status,
				request_id: error.request_id,
			});
			logReconnect("sse.reconnect", info);
			opts.onDisconnect?.(info);
			attempt += 1;
			await sleep(wait, opts.abort);
		}
	}
}

export function classifySseReconnect(consecutiveFailures: number): SseReconnectClassification {
	return consecutiveFailures <= TRANSIENT_RECONNECT_FAILURES ? "transient" : "sustained";
}

function buildReconnectInfo(
	fields: Omit<SseReconnectInfo, "classification" | "consecutive_failures">,
): SseReconnectInfo {
	const consecutiveFailures = fields.attempt + 1;
	return {
		...fields,
		consecutive_failures: consecutiveFailures,
		classification: classifySseReconnect(consecutiveFailures),
	};
}

function logReconnect(event: string, info: SseReconnectInfo): void {
	const fields = pruneUndefined({
		reason: info.reason,
		attempt: info.attempt,
		consecutive_failures: info.consecutive_failures,
		wait_ms: info.wait_ms,
		classification: info.classification,
		first_byte_received: info.first_byte_received,
		http_status: info.http_status,
		request_id: info.request_id,
	});
	if (info.classification === "sustained") {
		log.warn(event, fields);
	} else {
		log.info(event, fields);
	}
}

function pruneUndefined(fields: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

async function dialAndStream(opts: Opts & { onFirstByte?: () => void }): Promise<void> {
	const url = `${opts.apiUrl.replace(/\/+$/, "")}/v1/sync/events`;
	const accessToken = opts.getAccessToken ? await opts.getAccessToken() : opts.apiKey;
	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "text/event-stream",
			"Cache-Control": "no-cache",
			[SKILL_SYNC_PROTOCOL_HEADER]: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
		},
		signal: opts.abort,
	});

	if (res.status === 401 || res.status === 403) {
		throw new SseConnectionError("auth_failed", {
			httpStatus: res.status,
			requestId: res.headers.get("x-request-id"),
		});
	}
	if (res.status === 429) {
		const retryAfter = res.headers.get("retry-after");
		const retryAfterMs = parseRetryAfter(retryAfter);
		if (retryAfter !== null && retryAfterMs === null) {
			log.warn("sse.retry_after_unparseable", { value: retryAfter });
		}
		throw new SseConnectionError("rate_limited", {
			httpStatus: res.status,
			requestId: res.headers.get("x-request-id"),
			retryAfterMs,
		});
	}
	if (!res.ok) {
		throw new SseConnectionError(`http_${res.status}`, {
			httpStatus: res.status,
			requestId: res.headers.get("x-request-id"),
		});
	}
	if (!res.body) {
		throw new SseConnectionError("no_body", { requestId: res.headers.get("x-request-id") });
	}

	opts.onConnect?.();
	log.info("sse.connected", { url });

	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let lastChunkAt = Date.now();
	let staleDetected = false;

	// Side-channel timer: forces a reconnect if the server goes
	// silent past the stale threshold. We can't use fetch's own
	// timeout because SSE is, by design, a long-lived stream.
	const stale = setInterval(() => {
		if (Date.now() - lastChunkAt > STALE_MS) {
			log.warn("sse.stale_silence", { silence_ms: Date.now() - lastChunkAt });
			// Set the flag BEFORE cancelling the reader so the
			// read loop sees it on the resulting `done: true`.
			staleDetected = true;
			reader.cancel("stale").catch(() => {
				/* ignore — we're tearing down anyway */
			});
		}
	}, HEARTBEAT_HINT_MS);

	let firstByteFired = false;
	const pendingEvents: EventSourceMessage[] = [];
	const parser = createParser({
		onEvent: (event) => pendingEvents.push(event),
		onError: (error) => log.warn("sse.framing_invalid", { error: toErrorMessage(error) }),
	});
	const drainEvents = async (): Promise<void> => {
		while (pendingEvents.length > 0) {
			const parsed = parseEventMessage(pendingEvents.shift());
			if (parsed) await opts.onEvent(parsed);
		}
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				// If the stream ended because we cancelled it for
				// staleness, surface that as an error so consumeSse
				// runs its disconnect/backoff path. Without the
				// throw, dialAndStream returns cleanly, attempt
				// resets to 0, and the daemon hammers the server
				// every cycle.
				if (staleDetected) throw new Error("stale");
				parser.feed(decoder.decode());
				// Resolve a trailing bare CR, which is a complete SSE line
				// terminator but remains ambiguous to an incremental parser
				// until either the next byte or EOF is known.
				parser.feed("\n");
				await drainEvents();
				return;
			}
			if (!firstByteFired) {
				firstByteFired = true;
				opts.onFirstByte?.();
			}
			lastChunkAt = Date.now();
			parser.feed(decoder.decode(value, { stream: true }));
			await drainEvents();
		}
	} finally {
		clearInterval(stale);
	}
}

/** Parse one SSE record (everything up to a blank line). Comments
 * (`: foo`) and incomplete records return null. Exported so unit
 * tests can drive synthetic byte sequences without standing up a
 * full SSE round-trip. */
export function parseRecord(record: string): ServerEvent | null {
	let message: EventSourceMessage | undefined;
	createParser({ onEvent: (event) => (message = event) }).feed(`${record}\n\n`);
	return parseEventMessage(message);
}

function parseEventMessage(message: EventSourceMessage | undefined): ServerEvent | null {
	if (!message?.event || !message.data) return null;

	try {
		const parsed = parseServerEvent(JSON.parse(message.data) as unknown);
		if (!parsed) {
			log.warn("sse.event_invalid", { event_type: message.event });
			return null;
		}
		if (parsed.type !== message.event) {
			log.warn("sse.event_type_mismatch", { header: message.event, body_type: parsed.type });
		}
		return parsed;
	} catch (e) {
		log.warn("sse.parse_failed", { data: message.data, error: toErrorMessage(e) });
		return null;
	}
}

function parseServerEvent(value: unknown): ServerEvent | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const event = value as Record<string, unknown>;
	if (event.type === "runtime_manifest_changed") {
		return typeof event.environment_id === "string" && event.environment_id.length > 0
			? { type: event.type, environment_id: event.environment_id }
			: null;
	}
	const changed = isSkillChangedEventType(event.type);
	const deleted = isSkillDeletedEventType(event.type);
	if (!changed && !deleted) return null;
	if (
		typeof event.skill_key !== "string" ||
		event.skill_key.length === 0 ||
		typeof event.project_id !== "string" ||
		event.project_id.length === 0 ||
		typeof event.skills_revision !== "number" ||
		!Number.isInteger(event.skills_revision)
	) {
		return null;
	}
	if (changed && isSkillChangedEventType(event.type)) {
		return {
			type: event.type,
			skill_key: event.skill_key,
			project_id: event.project_id,
			skills_revision: event.skills_revision,
			...(typeof event.content_hash === "string" ? { content_hash: event.content_hash } : {}),
		};
	}
	if (!isSkillDeletedEventType(event.type)) return null;
	return {
		type: event.type,
		skill_key: event.skill_key,
		project_id: event.project_id,
		skills_revision: event.skills_revision,
	};
}

function errorInfo(err: unknown): {
	reason: string;
	http_status?: number;
	request_id?: string;
	retry_after_ms?: number;
} {
	if (err instanceof SseConnectionError) {
		return {
			reason: err.reason,
			http_status: err.httpStatus,
			request_id: err.requestId,
			retry_after_ms: err.retryAfterMs,
		};
	}
	if (!(err instanceof Error)) return { reason: "unknown" };
	if (err.message === "stale") return { reason: "stale" };
	if (err.name === "AbortError") return { reason: "aborted" };
	return { reason: err.message };
}

function backoffMs(attempt: number): number {
	const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
	const jitter = exp * 0.2 * (Math.random() * 2 - 1);
	return Math.max(BASE_BACKOFF_MS, Math.round(exp + jitter));
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (abort.aborted) {
			resolve();
			return;
		}
		// Listener must be removed when timeout wins, otherwise a
		// long reconnect storm leaks listeners on the same shared
		// AbortSignal and eventually trips MaxListenersExceededWarning.
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			abort.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		abort.addEventListener("abort", onAbort, { once: true });
	});
}
