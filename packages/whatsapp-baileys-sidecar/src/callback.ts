import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
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

export type CallbackDeliveryDependencies = {
	fetch: (input: string, init?: RequestInit) => Promise<Response>;
	sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

type JournalBatch = {
	path: string;
	events: NormalizedInboundMessage[];
	bytes: number;
};

const JOURNAL_SCHEMA = "clawdi.whatsapp.callback-spool.v1";
const BATCH_FILE_PATTERN = /^batch-(\d{20})\.json$/;
const TEMP_FILE_PATTERN = /^\.tmp-(batch-\d{20}\.json)-[0-9a-f-]{36}$/;

export class CallbackQueueFullError extends Error {
	constructor(message = "WhatsApp callback spool capacity exceeded") {
		super(message);
		this.name = "CallbackQueueFullError";
	}
}

export class CallbackSpoolCorruptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CallbackSpoolCorruptionError";
	}
}

export class ClawdiCallbackDeliveryQueue {
	private readonly batches: JournalBatch[];
	private processing: Promise<void> | null = null;
	private accepting = true;
	private stopping = false;
	private readonly shutdown = new AbortController();
	private pendingEvents = 0;
	private pendingByteCount = 0;
	private nextSequence: bigint;

	constructor(
		private readonly config: CallbackDeliveryConfig,
		private readonly logger: Logger,
		private readonly dependencies: CallbackDeliveryDependencies = {
			fetch,
			sleep: abortableSleep,
		},
	) {
		const recovered = loadJournal(config);
		this.batches = recovered.batches;
		this.nextSequence = recovered.nextSequence;
		for (const batch of this.batches) {
			this.pendingEvents += batch.events.length;
			this.pendingByteCount += batch.bytes;
		}
		this.startProcessing();
	}

	enqueue(event: NormalizedInboundMessage): void {
		this.enqueueBatch([event]);
	}

	enqueueBatch(events: readonly NormalizedInboundMessage[]): void {
		if (!this.accepting) {
			throw new Error("WhatsApp callback spool is stopping");
		}
		if (events.length === 0) return;
		const serialized = serializeBatch(events);
		const bytes = Buffer.byteLength(serialized);
		if (
			events.length > this.config.maxPendingEvents ||
			bytes > this.config.maxPendingBytes ||
			this.pendingEvents + events.length > this.config.maxPendingEvents ||
			this.pendingByteCount + bytes > this.config.maxPendingBytes
		) {
			throw new CallbackQueueFullError(
				`WhatsApp callback batch (${events.length} events, ${bytes} bytes) exceeds remaining spool capacity`,
			);
		}
		const sequence = this.nextSequence.toString().padStart(20, "0");
		if (sequence.length > 20) {
			throw new CallbackQueueFullError("WhatsApp callback spool sequence exhausted");
		}
		const path = join(this.config.spoolDir, `batch-${sequence}.json`);
		atomicWrite(path, serialized);
		this.nextSequence += 1n;
		this.batches.push({ path, events: [...events], bytes });
		this.pendingEvents += events.length;
		this.pendingByteCount += bytes;
		this.startProcessing();
	}

	async stop(): Promise<number> {
		this.accepting = false;
		this.stopping = true;
		this.shutdown.abort();
		await this.processing;
		return this.pendingEvents;
	}

	async waitForIdle(): Promise<void> {
		await this.processing;
	}

	pendingCount(): number {
		return this.pendingEvents;
	}

	pendingBytes(): number {
		return this.pendingByteCount;
	}

	private startProcessing(): void {
		if (this.processing || this.stopping || this.batches.length === 0) return;
		this.processing = this.processQueue().finally(() => {
			this.processing = null;
			if (this.batches.length > 0 && !this.stopping) this.startProcessing();
		});
	}

	private async processQueue(): Promise<void> {
		while (!this.stopping && this.batches.length > 0) {
			const batch = this.batches[0];
			const event = batch?.events[0];
			if (!batch || !event) {
				throw new CallbackSpoolCorruptionError("callback spool contains an empty batch");
			}
			const accepted = await this.deliverUntilAccepted(event);
			if (accepted) this.removeAcceptedHead(batch);
		}
	}

	private removeAcceptedHead(batch: JournalBatch): void {
		if (batch.events.length === 1) {
			unlinkSync(batch.path);
			fsyncDirectory(this.config.spoolDir);
			this.batches.shift();
			this.pendingEvents -= 1;
			this.pendingByteCount -= batch.bytes;
			return;
		}
		const remaining = batch.events.slice(1);
		const serialized = serializeBatch(remaining);
		const nextBytes = Buffer.byteLength(serialized);
		atomicWrite(batch.path, serialized);
		batch.events = remaining;
		this.pendingEvents -= 1;
		this.pendingByteCount += nextBytes - batch.bytes;
		batch.bytes = nextBytes;
	}

	private async deliverUntilAccepted(event: NormalizedInboundMessage): Promise<boolean> {
		for (let attempt = 1; !this.stopping; attempt += 1) {
			try {
				await this.deliver(event);
				return true;
			} catch (error: unknown) {
				if (this.stopping) return false;
				const delay = Math.min(
					this.config.maxBackoffMs,
					this.config.initialBackoffMs * 2 ** (attempt - 1),
				);
				this.logger.warn(
					{ error, attempt, delay, providerEventId: event.providerEventId },
					"WhatsApp callback delivery failed; retrying durable head event",
				);
				try {
					await this.dependencies.sleep(delay, this.shutdown.signal);
				} catch (sleepError: unknown) {
					if (this.stopping) return false;
					throw sleepError;
				}
			}
		}
		return false;
	}

	private async deliver(event: NormalizedInboundMessage): Promise<void> {
		const controller = new AbortController();
		const abortForShutdown = () => controller.abort();
		this.shutdown.signal.addEventListener("abort", abortForShutdown, { once: true });
		const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
		try {
			const response = await this.dependencies.fetch(this.config.url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.config.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(event),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`callback returned HTTP ${response.status}`);
			}
		} finally {
			clearTimeout(timeout);
			this.shutdown.signal.removeEventListener("abort", abortForShutdown);
		}
	}
}

function loadJournal(config: CallbackDeliveryConfig): {
	batches: JournalBatch[];
	nextSequence: bigint;
} {
	mkdirSync(config.spoolDir, { recursive: true, mode: 0o700 });
	const root = lstatSync(config.spoolDir);
	if (!root.isDirectory() || root.isSymbolicLink()) {
		throw new CallbackSpoolCorruptionError("callback spool root must be a real directory");
	}
	recoverAtomicWrites(config.spoolDir);
	const batches: JournalBatch[] = [];
	let eventCount = 0;
	let byteCount = 0;
	let maxSequence = 0n;
	for (const entry of readdirSync(config.spoolDir).sort()) {
		const match = BATCH_FILE_PATTERN.exec(entry);
		if (!match?.[1]) {
			throw new CallbackSpoolCorruptionError(`unexpected callback spool entry: ${entry}`);
		}
		const sequence = BigInt(match[1]);
		if (sequence > maxSequence) maxSequence = sequence;
		const path = join(config.spoolDir, entry);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new CallbackSpoolCorruptionError(
				`callback spool entry is not a regular file: ${entry}`,
			);
		}
		const raw = readFileSync(path);
		const events = parseBatch(raw, entry);
		eventCount += events.length;
		byteCount += raw.byteLength;
		if (eventCount > config.maxPendingEvents || byteCount > config.maxPendingBytes) {
			throw new CallbackSpoolCorruptionError(
				"recovered callback spool exceeds configured hard capacity",
			);
		}
		batches.push({ path, events, bytes: raw.byteLength });
	}
	return { batches, nextSequence: maxSequence + 1n };
}

function recoverAtomicWrites(spoolDir: string): void {
	const tempTargets = new Map<string, string>();
	for (const entry of readdirSync(spoolDir)) {
		const match = TEMP_FILE_PATTERN.exec(entry);
		if (!match?.[1]) continue;
		if (tempTargets.has(match[1])) {
			throw new CallbackSpoolCorruptionError(
				`ambiguous callback spool temporary files for ${match[1]}`,
			);
		}
		tempTargets.set(match[1], entry);
	}
	for (const [targetName, tempName] of tempTargets) {
		const tempPath = join(spoolDir, tempName);
		const stat = lstatSync(tempPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new CallbackSpoolCorruptionError(
				`callback spool temporary entry is not a regular file: ${tempName}`,
			);
		}
		parseBatch(readFileSync(tempPath), tempName);
		const targetPath = join(spoolDir, targetName);
		if (existsSync(targetPath)) {
			const targetStat = lstatSync(targetPath);
			if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
				throw new CallbackSpoolCorruptionError(
					`callback spool target is not a regular file: ${targetName}`,
				);
			}
			parseBatch(readFileSync(targetPath), targetName);
			unlinkSync(tempPath);
		} else {
			renameSync(tempPath, targetPath);
		}
		fsyncDirectory(spoolDir);
	}
}

function serializeBatch(events: readonly NormalizedInboundMessage[]): string {
	return JSON.stringify({ schemaVersion: JOURNAL_SCHEMA, events });
}

function parseBatch(raw: Buffer, fileName: string): NormalizedInboundMessage[] {
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch (error: unknown) {
		throw new CallbackSpoolCorruptionError(
			`invalid callback spool JSON in ${fileName}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== JOURNAL_SCHEMA ||
		!Array.isArray(value.events) ||
		value.events.length === 0 ||
		!value.events.every(isNormalizedEvent)
	) {
		throw new CallbackSpoolCorruptionError(`invalid callback spool batch: ${fileName}`);
	}
	return value.events;
}

function isNormalizedEvent(value: unknown): value is NormalizedInboundMessage {
	return (
		isRecord(value) &&
		value.schemaVersion === "clawdi.whatsapp.sidecar-event.v1" &&
		typeof value.providerEventId === "string" &&
		typeof value.messageId === "string" &&
		value.providerEventId === `message:${value.messageId}` &&
		typeof value.chatJid === "string" &&
		typeof value.actorJid === "string" &&
		value.fromMe === false &&
		typeof value.text === "string" &&
		value.text.length > 0
	);
}

function atomicWrite(path: string, data: string): void {
	const directory = dirname(path);
	const tempPath = join(directory, `.tmp-${basename(path)}-${randomUUID()}`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(tempPath, "wx", 0o600);
		writeFileSync(descriptor, data, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(tempPath, path);
		fsyncDirectory(directory);
	} catch (error: unknown) {
		if (descriptor !== undefined) closeSync(descriptor);
		if (existsSync(tempPath)) unlinkSync(tempPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
