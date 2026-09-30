import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { safeTruncate } from "../lib/sanitize";
import { projectEventsToMessages } from "../lib/session-events";
import type { RawSession, SessionEvent, SessionMessage, SyncReadContext } from "./base";
import { type JsonObject, jsonObject } from "./rich-event-mapping";

export const SESSION_RECORD_MAX_BYTES = 8 * 1024 * 1024;
const EAGER_SESSION_MAX_BYTES = 256 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;

export function addSessionModel(models: Set<string>, model: string): void {
	if (Buffer.byteLength(model) > 8192 || (!models.has(model) && models.size >= 128))
		throw new Error("session model metadata exceeds supported bounds");
	models.add(model);
}

export interface JsonlRecord {
	data: JsonObject;
	recordSeq: number;
	offset: number;
	length: number;
}

/** Pin a file prefix; appends belong to the next scan, rewrites invalidate this reader. */
export class JsonlSessionSource {
	private digest: string | undefined;
	complete = true;
	validRecords = 0;

	private constructor(
		readonly path: string,
		readonly stat: BigIntStats,
		private readonly context?: SyncReadContext,
	) {}

	static async open(path: string, context?: SyncReadContext): Promise<JsonlSessionSource> {
		context?.signal.throwIfAborted();
		const file = await open(path, "r");
		try {
			const stat = await file.stat({ bigint: true });
			if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER))
				throw new Error("session source is not a supported regular file");
			return new JsonlSessionSource(path, stat, context);
		} finally {
			await file.close();
		}
	}

	get eager(): boolean {
		return !this.context?.streaming && this.stat.size <= BigInt(EAGER_SESSION_MAX_BYTES);
	}

	get revision(): string | undefined {
		return this.digest === undefined ? undefined : `jsonl-v1:${this.stat.size}:${this.digest}`;
	}

	async unchanged(): Promise<boolean> {
		const file = await open(this.path, "r");
		try {
			const current = await file.stat({ bigint: true });
			return (
				current.dev === this.stat.dev &&
				current.ino === this.stat.ino &&
				current.size === this.stat.size &&
				current.mtimeNs === this.stat.mtimeNs
			);
		} finally {
			await file.close();
		}
	}

	async checkpoint(): Promise<void> {
		await setImmediate(undefined, this.context ? { signal: this.context.signal } : {});
	}

	private async verifyIdentity(file: FileHandle): Promise<BigIntStats> {
		const current = await file.stat({ bigint: true });
		const named = await stat(this.path, { bigint: true });
		if (
			current.dev !== this.stat.dev ||
			current.ino !== this.stat.ino ||
			current.size < this.stat.size ||
			named.dev !== this.stat.dev ||
			named.ino !== this.stat.ino
		)
			throw new Error("session source was replaced or truncated; retry with a fresh scan");
		return current;
	}

	async *records(): AsyncGenerator<JsonlRecord> {
		this.context?.signal.throwIfAborted();
		const file = await open(this.path, "r");
		try {
			const before = await this.verifyIdentity(file);
			const digest = createHash("sha256");
			const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
			let position = 0;
			let lineOffset = 0;
			let recordSeq = 0;
			let lineBytes = 0;
			let parts: Buffer[] = [];
			let complete = true;
			let validRecords = 0;
			const append = (part: Buffer) => {
				lineBytes += part.length;
				if (lineBytes > SESSION_RECORD_MAX_BYTES)
					throw new Error(`session source record exceeds ${SESSION_RECORD_MAX_BYTES} bytes`);
				if (part.length) parts.push(Buffer.from(part));
			};
			const record = (): JsonlRecord | null => {
				const line = Buffer.concat(parts, lineBytes).toString("utf8").trim();
				if (!line) return null;
				try {
					const data = jsonObject(JSON.parse(line));
					if (data) {
						validRecords++;
						return { data, recordSeq, offset: lineOffset, length: lineBytes };
					}
				} catch {
					// Match existing adapters: isolated malformed rows are not publishable.
				}
				complete = false;
				return null;
			};
			while (position < Number(this.stat.size)) {
				this.context?.signal.throwIfAborted();
				const { bytesRead } = await file.read(
					buffer,
					0,
					Math.min(buffer.length, Number(this.stat.size) - position),
					position,
				);
				if (!bytesRead) throw new Error("session source changed while reading");
				const bytes = buffer.subarray(0, bytesRead);
				digest.update(bytes);
				let start = 0;
				for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
					this.context?.signal.throwIfAborted();
					append(bytes.subarray(start, end));
					const value = record();
					if (value) yield value;
					parts = [];
					lineBytes = 0;
					lineOffset = position + end + 1;
					start = end + 1;
					if (++recordSeq % 128 === 0)
						await setImmediate(undefined, this.context ? { signal: this.context.signal } : {});
				}
				append(bytes.subarray(start));
				position += bytesRead;
			}
			if (lineBytes) {
				this.context?.signal.throwIfAborted();
				const value = record();
				if (value) yield value;
			}
			this.context?.signal.throwIfAborted();
			const after = await this.verifyIdentity(file);
			if (before.size === after.size && before.mtimeNs !== after.mtimeNs)
				throw new Error("session source changed while reading; retry with a fresh scan");
			const hash = digest.digest("hex");
			if (this.digest !== undefined && hash !== this.digest)
				throw new Error("session source was rewritten; retry with a fresh scan");
			this.digest = hash;
			this.complete = complete;
			this.validRecords = validRecords;
		} finally {
			await file.close();
		}
	}

	async readRecord(offset: number, length: number): Promise<JsonObject> {
		this.context?.signal.throwIfAborted();
		if (length > SESSION_RECORD_MAX_BYTES || offset < 0 || offset + length > Number(this.stat.size))
			throw new Error("invalid indexed session record boundary");
		const file = await open(this.path, "r");
		try {
			await this.verifyIdentity(file);
			const bytes = Buffer.allocUnsafe(length);
			let read = 0;
			while (read < length) {
				this.context?.signal.throwIfAborted();
				const { bytesRead } = await file.read(bytes, read, length - read, offset + read);
				if (!bytesRead) throw new Error("indexed session source changed while reading");
				read += bytesRead;
			}
			const data = jsonObject(JSON.parse(bytes.toString("utf8")));
			if (!data) throw new Error("indexed session record is not an object");
			return data;
		} finally {
			await file.close();
		}
	}
}

export async function readBoundedJsonFile(
	path: string,
	context?: SyncReadContext,
	maximum = 16 * 1024 * 1024,
): Promise<unknown> {
	context?.signal.throwIfAborted();
	const file = await open(path, "r");
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile() || before.size > BigInt(maximum))
			throw new Error("session inventory exceeds the supported metadata size");
		const bytes = Buffer.allocUnsafe(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			context?.signal.throwIfAborted();
			const { bytesRead } = await file.read(
				bytes,
				offset,
				Math.min(READ_BUFFER_BYTES, bytes.length - offset),
				offset,
			);
			if (!bytesRead) throw new Error("session inventory changed while reading");
			offset += bytesRead;
		}
		const after = await file.stat({ bigint: true });
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs)
			throw new Error("session inventory changed while reading");
		return JSON.parse(bytes.toString("utf8"));
	} finally {
		await file.close();
	}
}

export interface SessionContentSummary {
	content: Pick<RawSession, "events" | "messages" | "readEvents" | "lastMessageTimestamp">;
	messageCount: number;
	eventCount: number;
	firstUser: SessionMessage | undefined;
	firstTimestamp: string | undefined;
	lastTimestamp: string | undefined;
	modelsUsed: string[];
	lastModel: string | null;
}

export async function describeSessionContent(
	readEvents: () => AsyncIterable<SessionEvent>,
	eager: boolean,
	includeUser: (message: SessionMessage) => boolean = () => true,
): Promise<SessionContentSummary> {
	const events: SessionEvent[] = [];
	const messages: SessionMessage[] = [];
	const models = new Set<string>();
	let retain = eager;
	let retainedBytes = 0;
	let messageCount = 0;
	let eventCount = 0;
	let firstUser: SessionMessage | undefined;
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;
	let lastMessageTimestamp: string | undefined;
	let lastModel: string | null = null;
	for await (const event of readEvents()) {
		eventCount++;
		if (eventCount % 128 === 0) await setImmediate();
		if (retain) {
			retainedBytes += Buffer.byteLength(JSON.stringify(event));
			if (retainedBytes > EAGER_SESSION_MAX_BYTES) {
				retain = false;
				events.length = 0;
				messages.length = 0;
			} else events.push(event);
		}
		if (event.timestamp && !Number.isNaN(new Date(event.timestamp).getTime())) {
			firstTimestamp ??= event.timestamp;
			lastTimestamp = event.timestamp;
		}
		if ("model" in event && event.model) {
			addSessionModel(models, event.model);
			lastModel = event.model;
		}
		for (const message of projectEventsToMessages([event])) {
			messageCount++;
			if (retain) messages.push(message);
			if (!firstUser && message.role === "user" && includeUser(message))
				firstUser = { ...message, content: safeTruncate(message.content, 200) };
			if (message.timestamp && (!lastMessageTimestamp || message.timestamp > lastMessageTimestamp))
				lastMessageTimestamp = message.timestamp;
		}
	}
	return {
		content: retain ? { events, messages } : { messages: [], readEvents, lastMessageTimestamp },
		messageCount,
		eventCount,
		firstUser,
		firstTimestamp,
		lastTimestamp,
		modelsUsed: [...models],
		lastModel,
	};
}
