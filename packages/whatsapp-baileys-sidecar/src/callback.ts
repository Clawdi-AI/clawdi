import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Logger } from "pino";

import type { NormalizedInboundMessage } from "./types.js";

export type CallbackDeliveryConfig = {
	url: string;
	token: string;
	spoolDir: string;
	maxPendingEvents: number;
	maxPendingBytes: number;
	initialBackoffMs: number;
	maxBackoffMs: number;
	requestTimeoutMs: number;
};

export type CallbackDependencies = {
	fetch: (input: string, init: RequestInit) => Promise<Response>;
	sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	random: () => number;
};

type JournalEvent = { path: string; event: NormalizedInboundMessage; bytes: number };

const JOURNAL_SCHEMA = "clawdi.whatsapp.callback-spool.v1";
const EVENT_PATTERN = /^event-(\d{20})\.json$/;
const TEMP_PATTERN = /^\.tmp-(event-\d{20}\.json)-[0-9a-f-]{36}$/;

export class CallbackQueueFullError extends Error {
	constructor() {
		super("callback spool capacity exceeded");
		this.name = "CallbackQueueFullError";
	}
}

export class CallbackSpoolCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CallbackSpoolCorruptionError";
	}
}

export class CallbackPermanentDeliveryError extends Error {
	constructor(readonly status: number) {
		super(`callback permanently rejected an event with HTTP ${status}`);
		this.name = "CallbackPermanentDeliveryError";
	}
}

class CallbackRetryableError extends Error {}

export class CallbackJournal {
	private readonly events: JournalEvent[];
	private readonly eventIds: Set<string>;
	private nextSequence: bigint;
	private pendingByteCount = 0;
	private processing: Promise<void> | null = null;
	private accepting = true;
	private stopping = false;
	private fatal: Error | undefined;
	private readonly shutdown = new AbortController();

	constructor(
		private readonly config: CallbackDeliveryConfig,
		private readonly logger: Logger,
		private readonly onFatal: (error: Error) => void,
		private readonly dependencies: CallbackDependencies = {
			fetch,
			sleep: abortableSleep,
			random: Math.random,
		},
	) {
		const recovered = recoverJournal(config);
		this.events = recovered.events;
		this.nextSequence = recovered.nextSequence;
		this.eventIds = new Set(this.events.map(({ event }) => event.providerEventId));
		this.pendingByteCount = this.events.reduce((total, event) => total + event.bytes, 0);
		this.startProcessing();
	}

	enqueue(event: NormalizedInboundMessage): boolean {
		if (!this.accepting) throw new Error("callback spool is not accepting events");
		if (this.eventIds.has(event.providerEventId)) return false;
		const serialized = serializeEvent(event);
		const bytes = Buffer.byteLength(serialized);
		if (
			this.events.length + 1 > this.config.maxPendingEvents ||
			this.pendingByteCount + bytes > this.config.maxPendingBytes
		) {
			throw new CallbackQueueFullError();
		}
		const sequence = this.nextSequence.toString().padStart(20, "0");
		if (sequence.length !== 20) throw new CallbackQueueFullError();
		const path = join(this.config.spoolDir, `event-${sequence}.json`);
		atomicWrite(path, serialized);
		this.nextSequence += 1n;
		this.events.push({ path, event, bytes });
		this.eventIds.add(event.providerEventId);
		this.pendingByteCount += bytes;
		this.startProcessing();
		return true;
	}

	pendingCount(): number {
		return this.events.length;
	}

	pendingBytes(): number {
		return this.pendingByteCount;
	}

	fatalError(): Error | undefined {
		return this.fatal;
	}

	async waitForIdle(): Promise<void> {
		await this.processing;
		if (this.fatal) throw this.fatal;
	}

	async stop(): Promise<void> {
		this.accepting = false;
		this.stopping = true;
		this.shutdown.abort();
		await this.processing;
	}

	recover(): void {
		if (this.stopping) throw new Error("callback spool has been stopped");
		this.fatal = undefined;
		this.accepting = true;
		this.startProcessing();
	}

	private startProcessing(): void {
		if (this.processing || this.stopping || this.fatal || this.events.length === 0) return;
		this.processing = this.process()
			.catch((error: unknown) => {
				this.fatal = error instanceof Error ? error : new Error(String(error));
				this.accepting = false;
				this.logger.fatal(
					{ errorName: this.fatal.name },
					"WhatsApp callback delivery entered fail-stop",
				);
				try {
					this.onFatal(this.fatal);
				} catch {
					this.logger.fatal("WhatsApp callback fatal observer failed");
				}
			})
			.finally(() => {
				this.processing = null;
				if (!this.stopping && !this.fatal && this.events.length > 0) this.startProcessing();
			});
	}

	private async process(): Promise<void> {
		while (!this.stopping && this.events.length > 0) {
			const head = this.events[0];
			if (!head) throw new CallbackSpoolCorruptionError("callback journal head disappeared");
			await this.deliverUntilAccepted(head.event);
			if (this.stopping) return;
			unlinkSync(head.path);
			fsyncDirectory(this.config.spoolDir);
			this.events.shift();
			this.eventIds.delete(head.event.providerEventId);
			this.pendingByteCount -= head.bytes;
		}
	}

	private async deliverUntilAccepted(event: NormalizedInboundMessage): Promise<void> {
		let attempt = 0;
		while (!this.stopping) {
			try {
				await this.deliver(event);
				return;
			} catch (error: unknown) {
				if (this.stopping) return;
				if (error instanceof CallbackPermanentDeliveryError) throw error;
				attempt += 1;
				const exponential = Math.min(
					this.config.maxBackoffMs,
					this.config.initialBackoffMs * 2 ** Math.min(attempt - 1, 16),
				);
				const jitter = 0.5 + Math.max(0, Math.min(this.dependencies.random(), 1)) / 2;
				this.logger.warn(
					{ attempt, delayMs: Math.round(exponential * jitter) },
					"WhatsApp callback delivery will retry",
				);
				await this.dependencies.sleep(Math.round(exponential * jitter), this.shutdown.signal);
			}
		}
	}

	private async deliver(event: NormalizedInboundMessage): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
		const stopRequest = () => controller.abort();
		this.shutdown.signal.addEventListener("abort", stopRequest, { once: true });
		try {
			const response = await this.dependencies.fetch(this.config.url, {
				method: "POST",
				redirect: "manual",
				headers: {
					authorization: `Bearer ${this.config.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(event),
				signal: controller.signal,
			});
			if (response.status >= 200 && response.status < 300) return;
			if (
				response.status === 408 ||
				response.status === 429 ||
				(response.status >= 500 && response.status < 600)
			) {
				throw new CallbackRetryableError(`retryable callback HTTP ${response.status}`);
			}
			throw new CallbackPermanentDeliveryError(response.status);
		} catch (error: unknown) {
			if (
				error instanceof CallbackPermanentDeliveryError ||
				error instanceof CallbackRetryableError
			) {
				throw error;
			}
			throw new CallbackRetryableError("callback network request failed");
		} finally {
			clearTimeout(timeout);
			this.shutdown.signal.removeEventListener("abort", stopRequest);
		}
	}
}

function recoverJournal(config: CallbackDeliveryConfig): {
	events: JournalEvent[];
	nextSequence: bigint;
} {
	const events: Array<JournalEvent & { sequence: bigint }> = [];
	const eventIds = new Set<string>();
	let removedTemp = false;
	for (const name of readdirSync(config.spoolDir)) {
		const path = join(config.spoolDir, name);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new CallbackSpoolCorruptionError(`callback spool entry is not a regular file: ${name}`);
		}
		if (TEMP_PATTERN.test(name)) {
			unlinkSync(path);
			removedTemp = true;
			continue;
		}
		const match = EVENT_PATTERN.exec(name);
		if (!match?.[1]) throw new CallbackSpoolCorruptionError(`unknown callback spool file: ${name}`);
		const raw = readFileSync(path, "utf8");
		const event = parseEvent(raw, name);
		if (eventIds.has(event.providerEventId)) {
			throw new CallbackSpoolCorruptionError(
				"callback spool contains duplicate provider event ids",
			);
		}
		eventIds.add(event.providerEventId);
		chmodSync(path, 0o600);
		events.push({ path, event, bytes: Buffer.byteLength(raw), sequence: BigInt(match[1]) });
	}
	if (removedTemp) fsyncDirectory(config.spoolDir);
	events.sort((left, right) => (left.sequence < right.sequence ? -1 : 1));
	const pendingBytes = events.reduce((total, event) => total + event.bytes, 0);
	if (events.length > config.maxPendingEvents || pendingBytes > config.maxPendingBytes) {
		throw new CallbackQueueFullError();
	}
	const last = events.at(-1)?.sequence;
	return {
		events: events.map(({ sequence: _sequence, ...event }) => event),
		nextSequence: last === undefined ? 0n : last + 1n,
	};
}

function serializeEvent(event: NormalizedInboundMessage): string {
	return JSON.stringify({ schemaVersion: JOURNAL_SCHEMA, event });
}

function parseEvent(raw: string, name: string): NormalizedInboundMessage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CallbackSpoolCorruptionError(`invalid callback spool JSON: ${name}`);
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== JOURNAL_SCHEMA || !isRecord(parsed.event)) {
		throw new CallbackSpoolCorruptionError(`invalid callback spool envelope: ${name}`);
	}
	if (
		parsed.event.schemaVersion !== "clawdi.whatsapp.sidecar-event.v1" ||
		typeof parsed.event.providerEventId !== "string" ||
		!/^message:[0-9a-f]{64}$/.test(parsed.event.providerEventId)
	) {
		throw new CallbackSpoolCorruptionError(`invalid callback spool event: ${name}`);
	}
	return parsed.event as NormalizedInboundMessage;
}

function atomicWrite(path: string, data: string): void {
	const temp = join(dirname(path), `.tmp-${basename(path)}-${randomUUID()}`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temp, "wx", 0o600);
		writeFileSync(descriptor, data, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temp, path);
		chmodSync(path, 0o600);
		fsyncDirectory(dirname(path));
	} catch (error: unknown) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(temp)) unlinkSync(temp);
		throw error;
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
