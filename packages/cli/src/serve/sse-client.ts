/**
 * Outbound SSE consumer for `GET /api/sync/events`.
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

import { log, toErrorMessage } from "./log";

/** Events the server emits. Mirrors `bump_skills_revision` on
 * the backend; widen the union as new event types ship. Keep in
 * sync with `app/services/sync_events.py`.
 *
 * `scope_id` carries the scope that owns the affected skill —
 * daemons MUST drop events whose scope_id doesn't match their
 * env's default_scope_id, otherwise a skill_deleted in scope A
 * would prompt env B's daemon to delete its (different) local
 * skill with the same skill_key. The phase-1 design defers
 * server-side filtering to phase 2; daemon-side filtering is the
 * v1 mitigation. */
export type ServerEvent =
	| {
			type: "skill_changed";
			skill_key: string;
			scope_id: string;
			skills_revision: number;
			/** Tree hash of the bytes the server now stores. The
			 * daemon uses this to recognize its OWN upload echoing
			 * back via SSE: if the event's content_hash matches the
			 * daemon's lastPushedHash for that key, the bytes on
			 * disk already match and pulling would race a fresher
			 * local edit. Optional for forward/back compat with
			 * server versions that didn't carry the field. */
			content_hash?: string;
	  }
	| {
			type: "skill_deleted";
			skill_key: string;
			scope_id: string;
			skills_revision: number;
	  };

const STALE_MS = 60_000;
const HEARTBEAT_HINT_MS = 25_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

interface Opts {
	apiUrl: string;
	apiKey: string;
	abort: AbortSignal;
	onEvent: (event: ServerEvent) => void | Promise<void>;
	/** Called when the stream connects. Used by the daemon to
	 * surface "online/offline" in the heartbeat payload. */
	onConnect?: () => void;
	/** Called when the stream drops (network error, server close,
	 * stale read). Daemon flips status to "reconnecting". */
	onDisconnect?: (reason: string) => void;
	/** Called once on a 401, just before the consumer loop exits.
	 * Daemon shuts down — the deploy-key won't come back. */
	onAuthFailure?: () => void;
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
				attempt += 1;
				const wait = backoffMs(attempt);
				log.warn("sse.reconnect_unstable_close", {
					attempt,
					wait_ms: wait,
					first_byte_received: firstByteAt !== null,
				});
				await sleep(wait, opts.abort);
			}
		} catch (err) {
			if (opts.abort.aborted) return;
			const reason = errorReason(err);
			opts.onDisconnect?.(reason);
			if (reason === "auth_failed") {
				opts.onAuthFailure?.();
				return;
			}
			// Honor Retry-After on 429 rate-limit. The error message
			// carries the value as `rate_limited:<seconds>`; parse
			// it and use as the floor for this reconnect's wait.
			const rateLimitMs = parseRateLimit(reason);
			const wait = rateLimitMs ?? backoffMs(attempt);
			log.warn("sse.reconnect", { reason, attempt, wait_ms: wait });
			attempt += 1;
			await sleep(wait, opts.abort);
		}
	}
}

function parseRateLimit(reason: string): number | null {
	if (!reason.startsWith("rate_limited:")) return null;
	const raw = reason.slice("rate_limited:".length).trim();
	if (!raw) return null;
	// RFC 7231 §7.1.3 allows two formats for Retry-After:
	//   - delta-seconds (integer)
	//   - HTTP-date (RFC 1123 format, e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
	// Most servers send seconds, but Cloudflare and some CDNs send
	// dates. Try seconds first; if the value looks non-numeric, fall
	// through to Date.parse.
	let ms: number;
	const asSeconds = Number.parseInt(raw, 10);
	if (Number.isFinite(asSeconds) && /^\s*\d+\s*$/.test(raw)) {
		ms = asSeconds * 1000;
	} else {
		const t = Date.parse(raw);
		if (!Number.isFinite(t)) {
			log.warn("sse.retry_after_unparseable", { value: raw });
			return null;
		}
		ms = t - Date.now();
	}
	if (ms <= 0) return null;
	// Clamp at 5 minutes — if the server says wait an hour, that's
	// almost certainly a misbehaving proxy, and we'd rather cap the
	// daemon's silence to keep heartbeats flowing than sleep blind.
	return Math.min(ms, 5 * 60 * 1000);
}

async function dialAndStream(opts: Opts & { onFirstByte?: () => void }): Promise<void> {
	const url = `${opts.apiUrl.replace(/\/+$/, "")}/api/sync/events`;
	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			Accept: "text/event-stream",
			"Cache-Control": "no-cache",
		},
		signal: opts.abort,
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error("auth_failed");
	}
	if (res.status === 429) {
		throw new Error(`rate_limited:${res.headers.get("retry-after") ?? ""}`);
	}
	if (!res.ok) {
		throw new Error(`http_${res.status}`);
	}
	if (!res.body) {
		throw new Error("no_body");
	}

	opts.onConnect?.();
	log.info("sse.connected", { url });

	const reader = res.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
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
				return;
			}
			if (!firstByteFired) {
				firstByteFired = true;
				opts.onFirstByte?.();
			}
			lastChunkAt = Date.now();
			buffer += decoder.decode(value, { stream: true });

			// SSE record terminator is a blank line. Process every
			// completed record and keep the partial tail in `buffer`.
			let split: number = buffer.indexOf("\n\n");
			while (split !== -1) {
				const record = buffer.slice(0, split);
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
				const parsed = parseRecord(record);
				if (parsed) await opts.onEvent(parsed);
			}
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
	let eventType = "";
	let dataPayload = "";
	for (const line of record.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const field = line.slice(0, colon);
		// SSE allows one optional space after the colon.
		const value = line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") eventType = value;
		else if (field === "data") dataPayload += dataPayload ? `\n${value}` : value;
	}
	if (!eventType || !dataPayload) return null;

	try {
		const parsed = JSON.parse(dataPayload) as ServerEvent;
		if (parsed.type !== eventType) {
			log.warn("sse.event_type_mismatch", { header: eventType, body_type: parsed.type });
		}
		return parsed;
	} catch (e) {
		log.warn("sse.parse_failed", { record, error: toErrorMessage(e) });
		return null;
	}
}

function errorReason(err: unknown): string {
	if (!(err instanceof Error)) return "unknown";
	if (err.message === "auth_failed") return "auth_failed";
	if (err.message === "no_body") return "no_body";
	if (err.message === "stale") return "stale";
	if (err.message.startsWith("http_")) return err.message;
	if (err.message.startsWith("rate_limited")) return err.message;
	if (err.name === "AbortError") return "aborted";
	return err.message;
}

function backoffMs(attempt: number): number {
	const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
	const jitter = exp * 0.2 * (Math.random() * 2 - 1);
	return Math.max(BASE_BACKOFF_MS, Math.round(exp + jitter));
}

function sleep(ms: number, abort: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
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
