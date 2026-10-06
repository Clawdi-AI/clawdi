import { createHash, randomUUID } from "node:crypto";
import type { RawSession, SessionEvent, SessionMessage, SessionModule } from "../adapters/base";
import { type ApiClient, ApiError } from "./api-client";
import { canonicalApiOrigin } from "./api-origin";
import {
	advanceEventHead,
	canonicalJson,
	EMPTY_EVENT_HEAD,
	projectEventsToMessages,
} from "./session-events";
import {
	isSessionBlockCurrent,
	type PendingEventUpload,
	persistFencedSessionEntry,
	readFencedSessionEntry,
	readSessionsLock,
	type SessionFence,
	type SessionsLock,
} from "./sessions-lock";

import { getCliVersion } from "./version";

export type SelectedSessionProtocol = "snapshot-v1" | "events-v1";

export interface SessionUploadPlan {
	protocol: SelectedSessionProtocol;
	localHash: string;
	snapshotBytes?: Buffer;
	readSnapshot?: () => Promise<Buffer>;
	events?: readonly SessionEvent[];
	readEvents?: () => AsyncIterable<SessionEvent>;
	eventCount?: number;
	finalEventHead?: string;
	snapshotSizeBytes?: number;
}

export class SessionPlanStaleError extends Error {
	constructor(localSessionId: string) {
		super(`${localSessionId} upload plan is stale; retry with a fresh scan`);
		this.name = "SessionPlanStaleError";
	}
}

export type SessionContentSyncResult =
	| { status: "synced"; uploaded: boolean; localHash: string }
	| { status: "blocked"; uploaded: false; localHash: string; message: string };

interface EventHead {
	protocol: SelectedSessionProtocol;
	generation: string | null;
	revision: number;
	count: number;
	head_hash: string;
}

interface EventChunk {
	startSeq: number;
	count: number;
	bytes: Buffer;
	contentHash: string;
	baseHead: string;
	resultHead: string;
}

const LEGACY_SESSION_MAX_BYTES = 50 * 1024 * 1024;
const CLIENT_EVENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const EVENT_RETRY_LIMIT = 3;

class SnapshotAccumulator {
	private readonly hash = createHash("sha256").update("[");
	private readonly parts: Buffer[] = [];
	private count = 0;
	private size = 2;

	constructor(private readonly retain: boolean) {}

	add(message: SessionMessage): void {
		const bytes = Buffer.from(`${this.count++ ? "," : ""}${JSON.stringify(message)}`);
		this.hash.update(bytes);
		this.size += bytes.length;
		if (this.retain && this.size <= LEGACY_SESSION_MAX_BYTES) this.parts.push(bytes);
		else this.parts.length = 0;
	}

	finish(): { hash: string; size: number; bytes?: Buffer } {
		return {
			hash: this.hash.update("]").digest("hex"),
			size: this.size,
			...(this.retain && this.size <= LEGACY_SESSION_MAX_BYTES
				? { bytes: Buffer.concat([Buffer.from("["), ...this.parts, Buffer.from("]")]) }
				: {}),
		};
	}
}

async function snapshotPlan(session: RawSession): Promise<SessionUploadPlan> {
	const describe = async (retain: boolean) => {
		const accumulator = new SnapshotAccumulator(retain);
		for await (const message of readSessionMessages(session)) accumulator.add(message);
		return accumulator.finish();
	};
	const initial = await describe(false);
	return {
		protocol: "snapshot-v1",
		localHash: initial.hash,
		snapshotSizeBytes: initial.size,
		readSnapshot: async () => {
			const current = await describe(true);
			if (current.hash !== initial.hash || current.size !== initial.size || !current.bytes)
				throw new Error("snapshot source changed after planning; retry with a fresh scan");
			return current.bytes;
		},
	};
}

const capabilityRequests = new WeakMap<
	ApiClient,
	Promise<{ targetBytes: number; maxBytes: number } | null>
>();

export async function negotiateSessionProtocol(
	api: ApiClient,
	module: SessionModule,
	context?: import("../adapters/base").SyncReadContext,
): Promise<SelectedSessionProtocol> {
	if ((await module.contentProtocol(context)) === "snapshot-v1") return "snapshot-v1";
	const capabilities = await eventUploadCapabilities(api);
	return capabilities === null ? "snapshot-v1" : "events-v1";
}

export function planSessionUpload(
	session: RawSession,
	protocol: SelectedSessionProtocol,
): SessionUploadPlan {
	if (protocol === "snapshot-v1") {
		const accumulator = new SnapshotAccumulator(false);
		for (const message of session.messages) accumulator.add(message);
		const initial = accumulator.finish();
		return {
			protocol,
			localHash: initial.hash,
			snapshotSizeBytes: initial.size,
			readSnapshot: async () => {
				const accumulator = new SnapshotAccumulator(true);
				for (const message of session.messages) accumulator.add(message);
				const current = accumulator.finish();
				if (current.hash !== initial.hash || current.size !== initial.size || !current.bytes)
					throw new Error("snapshot source changed after planning; retry with a fresh scan");
				return current.bytes;
			},
		};
	}
	const events = session.events;
	if (!events) {
		throw new Error(`${session.localSessionId} has no events-v1 content`);
	}
	assertEventSequence(events);
	const finalEventHead = advanceEventHead(EMPTY_EVENT_HEAD, events);
	return {
		protocol,
		localHash: finalEventHead,
		events,
		eventCount: events.length,
		finalEventHead,
	};
}

export async function prepareSessionUpload(
	session: RawSession,
	protocol: SelectedSessionProtocol,
): Promise<SessionUploadPlan> {
	if (session.contentProtocol === "snapshot-v1") protocol = "snapshot-v1";
	if (protocol === "snapshot-v1") return snapshotPlan(session);
	if (!session.readEvents && !session.readMessages) return planSessionUpload(session, protocol);
	if (protocol === "events-v1") {
		if (!session.readEvents) throw new Error(`${session.localSessionId} has no events-v1 content`);
		let head = EMPTY_EVENT_HEAD;
		let count = 0;
		for await (const event of session.readEvents()) {
			assertEventIdentity(event, count++);
			head = advanceEventHead(head, [event]);
		}
		return {
			protocol,
			localHash: head,
			finalEventHead: head,
			eventCount: count,
			readEvents: session.readEvents,
		};
	}
	throw new Error("events-v1 plan is missing its event reader");
}

async function* readSessionMessages(session: RawSession): AsyncGenerator<SessionMessage> {
	if (session.readMessages) yield* session.readMessages();
	else if (session.readEvents) {
		for await (const event of session.readEvents()) yield* projectEventsToMessages([event]);
	} else yield* session.messages;
}

export function sessionFence(
	api: ApiClient,
	input: {
		environmentId: string;
		adapter: SessionFence["adapter"];
		sourceSessionKey: string;
		profileKey?: string;
	},
): SessionFence {
	return {
		apiOrigin: canonicalApiOrigin(api.baseUrl),
		environmentId: input.environmentId,
		adapter: input.adapter,
		sourceSessionKey: input.sourceSessionKey,
		...(input.profileKey !== undefined ? { profileKey: input.profileKey } : {}),
	};
}

export function sessionPlanIsDurablyBlocked(
	fence: SessionFence,
	plan: SessionUploadPlan,
	lock: SessionsLock = readSessionsLock(),
): string | null {
	const entry = readFencedSessionEntry(lock, fence);
	return entry?.local_hash === plan.localHash &&
		entry.blocked &&
		isSessionBlockCurrent(entry.blocked)
		? entry.blocked.message
		: null;
}

function sourceRevisionEntry(session: RawSession): { source_revision?: string } {
	return session.sourceRevision ? { source_revision: session.sourceRevision } : {};
}

export function persistSuppressedSession(
	fence: SessionFence,
	session: RawSession,
	plan: SessionUploadPlan,
): void {
	persistFencedSessionEntry(fence, {
		protocol: plan.protocol,
		local_hash: plan.localHash,
		...sourceRevisionEntry(session),
		...(plan.protocol === "snapshot-v1" ? { snapshot_hash: plan.localHash } : {}),
	});
}

export async function syncSessionContent(input: {
	api: ApiClient;
	fence: SessionFence;
	session: RawSession;
	plan: SessionUploadPlan;
	needsSnapshotContent: boolean;
	confirmPlanCurrent?: () => Promise<boolean>;
}): Promise<SessionContentSyncResult> {
	const blocked = sessionPlanIsDurablyBlocked(input.fence, input.plan);
	if (blocked) {
		return {
			status: "blocked",
			uploaded: false,
			localHash: input.plan.localHash,
			message: blocked,
		};
	}
	if (input.plan.protocol === "snapshot-v1") return syncSnapshotSession(input);
	return syncEventSession(input);
}

async function syncSnapshotSession(input: {
	api: ApiClient;
	fence: SessionFence;
	session: RawSession;
	plan: SessionUploadPlan;
	needsSnapshotContent: boolean;
}): Promise<SessionContentSyncResult> {
	const sizeBytes = input.plan.snapshotSizeBytes ?? input.plan.snapshotBytes?.length;
	if (sizeBytes !== undefined && sizeBytes > LEGACY_SESSION_MAX_BYTES) {
		return persistBlocked(input, {
			code: "legacy_session_too_large",
			sizeBytes,
			message: `${input.session.localSessionId} exceeds the legacy 50 MiB session limit`,
		});
	}
	let uploaded = false;
	if (input.needsSnapshotContent) {
		const bytes = input.plan.snapshotBytes ?? (await input.plan.readSnapshot?.());
		if (!bytes) throw new Error("snapshot-v1 plan is missing bytes");
		try {
			const response = await input.api.uploadSessionContent(
				input.session.localSessionId,
				bytes,
				`${input.session.localSessionId}.json`,
				{
					environmentId: input.fence.environmentId,
					profileKey: input.fence.profileKey,
					expectedContentHash: input.plan.localHash,
				},
			);
			if (response.content_hash !== input.plan.localHash) {
				throw new Error(
					`server stored hash ${response.content_hash}, expected ${input.plan.localHash}`,
				);
			}
			uploaded = true;
		} catch (error) {
			if (error instanceof ApiError && error.status === 413) {
				return persistBlocked(input, {
					code: "legacy_session_too_large",
					sizeBytes: bytes.length,
					message: `${input.session.localSessionId} was rejected by the legacy session size limit`,
				});
			}
			throw error;
		}
	}
	persistFencedSessionEntry(input.fence, {
		protocol: "snapshot-v1",
		local_hash: input.plan.localHash,
		...sourceRevisionEntry(input.session),
		snapshot_hash: input.plan.localHash,
	});
	return { status: "synced", uploaded, localHash: input.plan.localHash };
}

async function syncEventSession(input: {
	api: ApiClient;
	fence: SessionFence;
	session: RawSession;
	plan: SessionUploadPlan;
	confirmPlanCurrent?: () => Promise<boolean>;
}): Promise<SessionContentSyncResult> {
	const eventCount = input.plan.eventCount;
	const finalHead = input.plan.finalEventHead;
	if (eventCount === undefined || finalHead === undefined)
		throw new Error("events-v1 plan is incomplete");
	const capabilities = await eventUploadCapabilities(input.api);
	if (capabilities === null) {
		throw new Error("events-v1 capability disappeared after session negotiation");
	}
	let uploaded = false;
	let planConfirmed = false;
	for (let attempt = 0; attempt < EVENT_RETRY_LIMIT; attempt++) {
		const remote = await input.api.getSessionEventHead(
			input.session.localSessionId,
			input.fence.environmentId,
			input.fence.profileKey,
		);
		const head: EventHead = {
			protocol: remote.protocol,
			generation: remote.generation,
			revision: remote.revision,
			count: remote.count,
			head_hash: remote.head_hash,
		};
		if (head.count === eventCount && head.head_hash === finalHead && head.generation) {
			persistEventSuccess(input, head);
			return { status: "synced", uploaded, localHash: finalHead };
		}
		try {
			if (
				head.protocol === "events-v1" &&
				head.generation !== null &&
				head.count < eventCount &&
				(await eventPrefixHead(input.plan, head.count)) === head.head_hash
			) {
				const appendResult = await appendEvents(input, head, capabilities);
				uploaded = uploaded || appendResult.uploaded;
				persistEventSuccess(input, appendResult.head);
				return { status: "synced", uploaded, localHash: finalHead };
			}
			if (head.generation && head.count > eventCount && !planConfirmed) {
				if (!input.confirmPlanCurrent || (await input.confirmPlanCurrent()) !== true)
					throw new SessionPlanStaleError(input.session.localSessionId);
				planConfirmed = true;
			}
			const rewriteResult = await replaceEventGeneration(input, head, capabilities);
			uploaded = uploaded || rewriteResult.uploaded;
			persistEventSuccess(input, rewriteResult.head);
			return { status: "synced", uploaded, localHash: finalHead };
		} catch (error) {
			if (error instanceof EventTooLargeError) {
				return persistBlocked(input, {
					code: "event_too_large",
					sizeBytes: error.sizeBytes,
					message: error.message,
				});
			}
			if (error instanceof EventSchemaInvalidError) {
				return persistBlocked(input, {
					code: "event_schema_invalid",
					message: `${input.session.localSessionId} events-v1 upload rejected: ${error.message}`,
				});
			}
			if (error instanceof ApiError && error.status === 410) {
				const prior = readFencedSessionEntry(readSessionsLock(), input.fence);
				if (prior?.pending?.kind !== "rewrite") throw error;
				// Expired staging identities must never be resumed on the next attempt.
				const entry = { ...prior };
				delete entry.pending;
				persistFencedSessionEntry(input.fence, entry);
				continue;
			}
			if (!(error instanceof ApiError) || error.status !== 409) throw error;
		}
	}
	throw new Error(`${input.session.localSessionId} event head changed during every retry`);
}

async function appendEvents(
	input: {
		api: ApiClient;
		fence: SessionFence;
		session: RawSession;
		plan: SessionUploadPlan;
	},
	initialHead: EventHead,
	limits: { targetBytes: number; maxBytes: number },
): Promise<{ head: EventHead; uploaded: boolean }> {
	if (!initialHead.generation) throw new Error("cannot append without a generation");
	const generation = initialHead.generation;
	let head = initialHead;
	let uploaded = false;
	for await (const chunk of chunkEvents(input.plan, initialHead.count, limits)) {
		const finalCount = chunk.startSeq + chunk.count;
		const pendingShape = {
			kind: "append" as const,
			generation,
			base_generation: generation,
			base_revision: head.revision,
			base_count: chunk.startSeq,
			base_head_hash: chunk.baseHead,
			final_count: finalCount,
			final_head_hash: chunk.resultHead,
		};
		const appendId = reusableAppendId(input.fence, pendingShape) ?? randomUUID();
		persistPending(input, { ...pendingShape, append_id: appendId });
		const response = await validateEventUpload(() =>
			input.api.appendSessionEvents({
				localSessionId: input.session.localSessionId,
				environmentId: input.fence.environmentId,
				profileKey: input.fence.profileKey,
				appendId,
				generation,
				baseRevision: head.revision,
				baseCount: chunk.startSeq,
				baseHeadHash: chunk.baseHead,
				finalCount,
				finalHeadHash: chunk.resultHead,
				contentHash: chunk.contentHash,
				file: chunk.bytes,
			}),
		);
		assertEventResponse(response, {
			generation,
			revision: head.revision + 1,
			count: finalCount,
			headHash: chunk.resultHead,
		});
		head = {
			protocol: "events-v1",
			generation: response.generation,
			revision: response.revision,
			count: response.count,
			head_hash: response.head_hash,
		};
		uploaded = true;
	}
	return { head, uploaded };
}

async function replaceEventGeneration(
	input: {
		api: ApiClient;
		fence: SessionFence;
		session: RawSession;
		plan: SessionUploadPlan;
	},
	base: EventHead,
	limits: { targetBytes: number; maxBytes: number },
): Promise<{ head: EventHead; uploaded: boolean }> {
	const finalHead = input.plan.finalEventHead;
	const eventCount = input.plan.eventCount;
	if (!finalHead || eventCount === undefined) throw new Error("events-v1 plan is incomplete");
	const pendingShape = {
		kind: "rewrite" as const,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: eventCount,
		final_head_hash: finalHead,
	};
	const reusable = reusablePending(input.fence, pendingShape);
	const pending: PendingEventUpload = reusable ?? {
		...pendingShape,
		append_id: randomUUID(),
		generation: randomUUID(),
	};
	persistPending(input, pending);
	const commitBody = {
		...(input.fence.profileKey !== undefined ? { profile_key: input.fence.profileKey } : {}),
		append_id: pending.append_id,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: eventCount,
		final_head_hash: finalHead,
	};
	const staged = await input.api.stageSessionEventGeneration(input.session.localSessionId, {
		environment_id: input.fence.environmentId,
		...(input.fence.profileKey !== undefined ? { profile_key: input.fence.profileKey } : {}),
		generation: pending.generation,
		append_id: pending.append_id,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: eventCount,
		final_head_hash: finalHead,
	});
	if (staged.generation !== pending.generation) {
		throw new Error(
			`server staged generation ${staged.generation}, expected ${pending.generation}`,
		);
	}
	if (staged.status === "committed") {
		const committed = await input.api.commitSessionEventGeneration(
			input.session.localSessionId,
			pending.generation,
			commitBody,
		);
		assertEventResponse(committed, {
			generation: pending.generation,
			revision: base.revision + 1,
			count: eventCount,
			headHash: finalHead,
		});
		return {
			head: {
				protocol: "events-v1",
				generation: committed.generation,
				revision: committed.revision,
				count: committed.count,
				head_hash: committed.head_hash,
			},
			uploaded: false,
		};
	}
	let uploaded = false;
	for await (const chunk of chunkEvents(input.plan, 0, limits)) {
		const response = await validateEventUpload(() =>
			input.api.uploadSessionEventGenerationChunk({
				localSessionId: input.session.localSessionId,
				generation: pending.generation,
				startSeq: chunk.startSeq,
				baseHeadHash: chunk.baseHead,
				contentHash: chunk.contentHash,
				file: chunk.bytes,
			}),
		);
		if (
			response.generation !== pending.generation ||
			response.start_seq !== chunk.startSeq ||
			response.end_seq !== chunk.startSeq + chunk.count - 1 ||
			response.count !== chunk.count ||
			response.content_hash !== chunk.contentHash ||
			response.result_head_hash !== chunk.resultHead
		) {
			throw new Error("server event chunk receipt does not match uploaded bytes");
		}
		uploaded = true;
	}
	const committed = await input.api.commitSessionEventGeneration(
		input.session.localSessionId,
		pending.generation,
		commitBody,
	);
	assertEventResponse(committed, {
		generation: pending.generation,
		revision: base.revision + 1,
		count: eventCount,
		headHash: finalHead,
	});
	return {
		head: {
			protocol: "events-v1",
			generation: committed.generation,
			revision: committed.revision,
			count: committed.count,
			head_hash: committed.head_hash,
		},
		uploaded,
	};
}

async function* chunkEvents(
	plan: SessionUploadPlan,
	startSeq: number,
	limits: { targetBytes: number; maxBytes: number },
): AsyncGenerator<EventChunk> {
	let head = EMPTY_EVENT_HEAD;
	let baseHead = head;
	let chunkStart = startSeq;
	let count = 0;
	let size = 0;
	let lines: string[] = [];
	const chunk = (): EventChunk => {
		const bytes = Buffer.from(lines.join(""), "ascii");
		return {
			startSeq: chunkStart,
			count,
			bytes,
			contentHash: sha256(bytes),
			baseHead,
			resultHead: head,
		};
	};
	for await (const event of readPlanEvents(plan)) {
		if (event.seq < startSeq) {
			head = advanceEventHead(head, [event]);
			baseHead = head;
			continue;
		}
		const line = `${canonicalJson(event)}\n`;
		const lineSize = Buffer.byteLength(line, "ascii");
		if (lineSize > limits.maxBytes)
			throw new EventTooLargeError(event.seq, lineSize, limits.maxBytes);
		if (count && size + lineSize > limits.targetBytes) {
			yield chunk();
			chunkStart += count;
			baseHead = head;
			count = 0;
			size = 0;
			lines = [];
		}
		lines.push(line);
		size += lineSize;
		count++;
		head = advanceEventHead(head, [event]);
	}
	if (count) yield chunk();
}

async function* readPlanEvents(plan: SessionUploadPlan): AsyncGenerator<SessionEvent> {
	const events = plan.readEvents?.() ?? plan.events;
	if (!events) throw new Error("events-v1 plan is missing its reader");
	let count = 0;
	let head = EMPTY_EVENT_HEAD;
	for await (const event of events) {
		assertEventIdentity(event, count++);
		head = advanceEventHead(head, [event]);
		yield event;
	}
	if (count !== plan.eventCount || head !== plan.finalEventHead) {
		throw new Error("session source changed after upload planning; retry with a fresh plan");
	}
}

async function eventPrefixHead(
	plan: SessionUploadPlan,
	count: number,
): Promise<string | undefined> {
	let head = EMPTY_EVENT_HEAD;
	let prefix = count === 0 ? head : undefined;
	for await (const event of readPlanEvents(plan)) {
		head = advanceEventHead(head, [event]);
		if (event.seq + 1 === count) prefix = head;
	}
	return prefix;
}

function assertEventSequence(events: readonly SessionEvent[]): void {
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event) throw new Error("events-v1 event is missing");
		assertEventIdentity(event, index);
	}
}

function assertEventIdentity(event: SessionEvent, index: number): void {
	if (event.seq !== index) throw new Error("events-v1 seq must be continuous from zero");
	const expectedId = createHash("sha256")
		.update(canonicalJson({ source: event.source, type: event.type }), "ascii")
		.digest("hex");
	if (event.event_id !== expectedId) throw new Error(`events-v1 event_id mismatch at seq ${index}`);
}

function persistEventSuccess(
	input: { fence: SessionFence; session: RawSession; plan: SessionUploadPlan },
	head: EventHead,
): void {
	if (!head.generation) throw new Error("events-v1 success is missing generation");
	persistFencedSessionEntry(input.fence, {
		protocol: "events-v1",
		local_hash: input.plan.localHash,
		...sourceRevisionEntry(input.session),
		event_generation: head.generation,
		event_revision: head.revision,
		event_count: head.count,
		event_head_hash: head.head_hash,
	});
}

function persistPending(
	input: { fence: SessionFence; session: RawSession; plan: SessionUploadPlan },
	pending: PendingEventUpload,
): void {
	const prior = readFencedSessionEntry(readSessionsLock(), input.fence);
	persistFencedSessionEntry(input.fence, {
		protocol: "events-v1",
		local_hash: input.plan.localHash,
		...(prior?.source_revision ? { source_revision: prior.source_revision } : {}),
		...(prior?.event_generation ? { event_generation: prior.event_generation } : {}),
		...(prior?.event_revision === undefined ? {} : { event_revision: prior.event_revision }),
		...(prior?.event_count === undefined ? {} : { event_count: prior.event_count }),
		...(prior?.event_head_hash ? { event_head_hash: prior.event_head_hash } : {}),
		pending,
	});
}

function reusableAppendId(
	fence: SessionFence,
	shape: Omit<PendingEventUpload, "append_id">,
): string | null {
	return reusablePending(fence, shape)?.append_id ?? null;
}

function reusablePending(
	fence: SessionFence,
	shape: Omit<PendingEventUpload, "append_id" | "generation"> & { generation?: string },
): PendingEventUpload | null {
	const pending = readFencedSessionEntry(readSessionsLock(), fence)?.pending;
	if (!pending) return null;
	return pending.kind === shape.kind &&
		(shape.generation === undefined || pending.generation === shape.generation) &&
		pending.base_generation === shape.base_generation &&
		pending.base_revision === shape.base_revision &&
		pending.base_count === shape.base_count &&
		pending.base_head_hash === shape.base_head_hash &&
		pending.final_count === shape.final_count &&
		pending.final_head_hash === shape.final_head_hash
		? pending
		: null;
}

function persistBlocked(
	input: { fence: SessionFence; session: RawSession; plan: SessionUploadPlan },
	block: {
		code: "legacy_session_too_large" | "event_too_large" | "event_schema_invalid";
		sizeBytes?: number;
		message: string;
	},
): SessionContentSyncResult {
	persistFencedSessionEntry(input.fence, {
		protocol: input.plan.protocol,
		local_hash: input.plan.localHash,
		...sourceRevisionEntry(input.session),
		...(input.plan.protocol === "snapshot-v1" ? { snapshot_hash: input.plan.localHash } : {}),
		blocked: {
			code: block.code,
			content_hash: input.plan.localHash,
			...(block.sizeBytes === undefined ? {} : { size_bytes: block.sizeBytes }),
			message: block.message,
			blocked_at: new Date().toISOString(),
			cli_version: getCliVersion(),
		},
	});
	return {
		status: "blocked",
		uploaded: false,
		localHash: input.plan.localHash,
		message: block.message,
	};
}

function assertEventResponse(
	response: { generation: string; revision: number; count: number; head_hash: string },
	expected: { generation: string; revision: number; count: number; headHash: string },
): void {
	if (
		response.generation !== expected.generation ||
		response.revision !== expected.revision ||
		response.count !== expected.count ||
		response.head_hash !== expected.headHash
	) {
		throw new Error("server event receipt does not match the expected committed head");
	}
}

async function eventUploadCapabilities(
	api: ApiClient,
): Promise<{ targetBytes: number; maxBytes: number } | null> {
	let request = capabilityRequests.get(api);
	if (!request) {
		request = api.getSessionUploadCapabilities().then((response) => {
			if (!response?.protocols.includes("events-v1")) return null;
			const maxBytes = Math.min(
				CLIENT_EVENT_CHUNK_MAX_BYTES,
				Math.max(1, response.event_chunk_max_bytes),
			);
			const targetBytes = Math.min(
				maxBytes,
				4 * 1024 * 1024,
				Math.max(1024 * 1024, response.event_chunk_target_bytes),
			);
			return { targetBytes, maxBytes };
		});
		capabilityRequests.set(api, request);
	}
	return request;
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

class EventTooLargeError extends Error {
	constructor(
		readonly seq: number,
		readonly sizeBytes: number,
		maxBytes: number,
	) {
		super(
			`events-v1 event ${seq} is ${sizeBytes} bytes and exceeds the ${maxBytes} byte chunk limit`,
		);
		this.name = "EventTooLargeError";
	}
}

class EventSchemaInvalidError extends Error {}

async function validateEventUpload<T>(upload: () => Promise<T>): Promise<T> {
	try {
		return await upload();
	} catch (error) {
		if (error instanceof ApiError && error.status === 422)
			throw new EventSchemaInvalidError(error.message);
		throw error;
	}
}
