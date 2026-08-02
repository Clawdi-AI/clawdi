import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export type ProviderMessageEvent = {
	sequence: number;
	eventType: "messages.upsert";
	messageId: string;
	remoteJid: string;
	remoteJidAlt?: string;
	participant?: string;
	participantAlt?: string;
	fromMe: boolean;
	pushName?: string;
	messageTimestamp?: number;
	messageProtoBase64: string;
};

export type ProviderMessageEventInput = Omit<ProviderMessageEvent, "sequence">;

const EVENT_FILE_PATTERN = /^(\d{20})\.json$/;

/**
 * Disk-backed handoff from the single physical Baileys socket to Clawdi's
 * durable channel inbox. Files are removed only after the backend commits and
 * acknowledges their sequence.
 */
export class DurableProviderInbox {
	private nextSequence: number;

	constructor(private readonly directory: string) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const last = this.eventFiles().at(-1);
		this.nextSequence = last ? last.sequence + 1 : 1;
	}

	append(event: ProviderMessageEventInput): ProviderMessageEvent {
		const stored = { sequence: this.nextSequence, ...event } satisfies ProviderMessageEvent;
		this.nextSequence += 1;
		const path = this.eventPath(stored.sequence);
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
		return stored;
	}

	list(limit: number): ProviderMessageEvent[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("provider inbox limit must be between 1 and 100");
		}
		return this.eventFiles()
			.slice(0, limit)
			.map(({ path, sequence }) => parseProviderMessageEvent(path, sequence));
	}

	acknowledge(throughSequence: number): void {
		if (!Number.isInteger(throughSequence) || throughSequence < 1) {
			throw new Error("provider inbox acknowledgement must be a positive integer");
		}
		for (const event of this.eventFiles()) {
			if (event.sequence > throughSequence) break;
			unlinkSync(event.path);
		}
	}

	private eventFiles(): Array<{ path: string; sequence: number }> {
		return readdirSync(this.directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && EVENT_FILE_PATTERN.test(entry.name))
			.map((entry) => ({
				path: join(this.directory, entry.name),
				sequence: Number.parseInt(entry.name.slice(0, 20), 10),
			}))
			.sort((left, right) => left.sequence - right.sequence);
	}

	private eventPath(sequence: number): string {
		return join(this.directory, `${String(sequence).padStart(20, "0")}.json`);
	}
}

function parseProviderMessageEvent(path: string, expectedSequence: number): ProviderMessageEvent {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error: unknown) {
		throw new Error(
			`invalid provider inbox event ${basename(path)}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (!isRecord(value)) throw new Error(`invalid provider inbox event ${basename(path)}`);
	if (
		value.sequence !== expectedSequence ||
		value.eventType !== "messages.upsert" ||
		typeof value.messageId !== "string" ||
		!value.messageId ||
		typeof value.remoteJid !== "string" ||
		!value.remoteJid ||
		typeof value.fromMe !== "boolean" ||
		typeof value.messageProtoBase64 !== "string"
	) {
		throw new Error(`invalid provider inbox event ${basename(path)}`);
	}
	const remoteJidAlt = stringValue(value.remoteJidAlt);
	const participant = stringValue(value.participant);
	const participantAlt = stringValue(value.participantAlt);
	const pushName = stringValue(value.pushName);
	const messageTimestamp = positiveInteger(value.messageTimestamp)
		? value.messageTimestamp
		: undefined;
	return {
		sequence: expectedSequence,
		eventType: "messages.upsert",
		messageId: value.messageId,
		remoteJid: value.remoteJid,
		...(remoteJidAlt ? { remoteJidAlt } : {}),
		...(participant ? { participant } : {}),
		...(participantAlt ? { participantAlt } : {}),
		fromMe: value.fromMe,
		...(pushName ? { pushName } : {}),
		...(messageTimestamp ? { messageTimestamp } : {}),
		messageProtoBase64: value.messageProtoBase64,
	};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
