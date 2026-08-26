import { createHash, randomUUID } from "node:crypto";
import type { RawSession, SessionEvent, SessionModule } from "../adapters/base";
import { type ApiClient, ApiError } from "./api-client";
import { canonicalApiOrigin } from "./api-origin";
import {
	advanceEventHead,
	canonicalJson,
	EMPTY_EVENT_HEAD,
	encodeEventNdjson,
} from "./session-events";
import {
	type PendingEventUpload,
	persistFencedSessionEntry,
	readFencedSessionEntry,
	readSessionsLock,
	type SessionFence,
} from "./sessions-lock";

export type SelectedSessionProtocol = "snapshot-v1" | "events-v1";

export interface SessionUploadPlan {
	protocol: SelectedSessionProtocol;
	localHash: string;
	snapshotBytes?: Buffer;
	events?: readonly SessionEvent[];
	finalEventHead?: string;
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
	events: readonly SessionEvent[];
	bytes: Buffer;
	contentHash: string;
	baseHead: string;
	resultHead: string;
}

const LEGACY_SESSION_MAX_BYTES = 50 * 1024 * 1024;
const CLIENT_EVENT_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
const EVENT_RETRY_LIMIT = 3;

const capabilityRequests = new WeakMap<
	ApiClient,
	Promise<{ targetBytes: number; maxBytes: number } | null>
>();

export async function negotiateSessionProtocol(
	api: ApiClient,
	module: SessionModule,
): Promise<SelectedSessionProtocol> {
	if ((await module.contentProtocol()) === "snapshot-v1") return "snapshot-v1";
	const capabilities = await eventUploadCapabilities(api);
	return capabilities === null ? "snapshot-v1" : "events-v1";
}

export function planSessionUpload(
	session: RawSession,
	protocol: SelectedSessionProtocol,
): SessionUploadPlan {
	if (protocol === "snapshot-v1") {
		const snapshotBytes = Buffer.from(JSON.stringify(session.messages), "utf-8");
		return {
			protocol,
			localHash: sha256(snapshotBytes),
			snapshotBytes,
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
		finalEventHead,
	};
}

export function sessionFence(
	api: ApiClient,
	input: {
		environmentId: string;
		adapter: SessionFence["adapter"];
		sourceSessionKey: string;
	},
): SessionFence {
	return {
		apiOrigin: canonicalApiOrigin(api.baseUrl),
		environmentId: input.environmentId,
		adapter: input.adapter,
		sourceSessionKey: input.sourceSessionKey,
	};
}

export function sessionPlanMatchesLock(fence: SessionFence, plan: SessionUploadPlan): boolean {
	const entry = readFencedSessionEntry(readSessionsLock(), fence);
	return (
		entry?.protocol === plan.protocol &&
		entry.local_hash === plan.localHash &&
		entry.pending === undefined &&
		entry.blocked === undefined
	);
}

export function sessionPlanIsDurablyBlocked(
	fence: SessionFence,
	plan: SessionUploadPlan,
): string | null {
	const entry = readFencedSessionEntry(readSessionsLock(), fence);
	return entry?.local_hash === plan.localHash ? (entry.blocked?.message ?? null) : null;
}

export function persistSuppressedSession(fence: SessionFence, plan: SessionUploadPlan): void {
	persistFencedSessionEntry(fence, {
		protocol: plan.protocol,
		local_hash: plan.localHash,
		...(plan.protocol === "snapshot-v1" ? { snapshot_hash: plan.localHash } : {}),
	});
}

export async function syncSessionContent(input: {
	api: ApiClient;
	fence: SessionFence;
	session: RawSession;
	plan: SessionUploadPlan;
	needsSnapshotContent: boolean;
}): Promise<SessionContentSyncResult> {
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
	const bytes = input.plan.snapshotBytes;
	if (!bytes) throw new Error("snapshot-v1 plan is missing bytes");
	if (bytes.length > LEGACY_SESSION_MAX_BYTES) {
		return persistBlocked(input, {
			code: "legacy_session_too_large",
			sizeBytes: bytes.length,
			message: `${input.session.localSessionId} exceeds the legacy 50 MiB session limit`,
		});
	}
	let uploaded = false;
	if (input.needsSnapshotContent) {
		try {
			const response = await input.api.uploadSessionContent(
				input.session.localSessionId,
				bytes,
				`${input.session.localSessionId}.json`,
				{
					environmentId: input.fence.environmentId,
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
		snapshot_hash: input.plan.localHash,
	});
	return { status: "synced", uploaded, localHash: input.plan.localHash };
}

async function syncEventSession(input: {
	api: ApiClient;
	fence: SessionFence;
	session: RawSession;
	plan: SessionUploadPlan;
}): Promise<SessionContentSyncResult> {
	const events = input.plan.events;
	const finalHead = input.plan.finalEventHead;
	if (!events || finalHead === undefined) throw new Error("events-v1 plan is incomplete");
	const capabilities = await eventUploadCapabilities(input.api);
	if (capabilities === null) {
		throw new Error("events-v1 capability disappeared after session negotiation");
	}
	const heads = eventHeads(events);
	let uploaded = false;
	for (let attempt = 0; attempt < EVENT_RETRY_LIMIT; attempt++) {
		const remote = await input.api.getSessionEventHead(
			input.session.localSessionId,
			input.fence.environmentId,
		);
		const head: EventHead = {
			protocol: remote.protocol,
			generation: remote.generation,
			revision: remote.revision,
			count: remote.count,
			head_hash: remote.head_hash,
		};
		if (head.count === events.length && head.head_hash === finalHead && head.generation) {
			persistEventSuccess(input, head);
			return { status: "synced", uploaded, localHash: finalHead };
		}
		try {
			if (
				head.protocol === "events-v1" &&
				head.generation !== null &&
				head.count < events.length &&
				heads[head.count] === head.head_hash
			) {
				const appendResult = await appendEvents(input, head, events, heads, capabilities);
				uploaded = uploaded || appendResult.uploaded;
				persistEventSuccess(input, appendResult.head);
				return { status: "synced", uploaded, localHash: finalHead };
			}
			const rewriteResult = await replaceEventGeneration(input, head, events, capabilities);
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
	events: readonly SessionEvent[],
	heads: readonly string[],
	limits: { targetBytes: number; maxBytes: number },
): Promise<{ head: EventHead; uploaded: boolean }> {
	if (!initialHead.generation) throw new Error("cannot append without a generation");
	let head = initialHead;
	const chunks = chunkEvents(events.slice(initialHead.count), initialHead.count, limits, heads);
	for (const chunk of chunks) {
		const finalCount = chunk.startSeq + chunk.events.length;
		const pendingShape = {
			kind: "append" as const,
			generation: initialHead.generation,
			base_generation: initialHead.generation,
			base_revision: head.revision,
			base_count: chunk.startSeq,
			base_head_hash: chunk.baseHead,
			final_count: finalCount,
			final_head_hash: chunk.resultHead,
		};
		const appendId = reusableAppendId(input.fence, pendingShape) ?? randomUUID();
		persistPending(input, { ...pendingShape, append_id: appendId });
		const response = await input.api.appendSessionEvents({
			localSessionId: input.session.localSessionId,
			environmentId: input.fence.environmentId,
			appendId,
			generation: initialHead.generation,
			baseRevision: head.revision,
			baseCount: chunk.startSeq,
			baseHeadHash: chunk.baseHead,
			finalCount,
			finalHeadHash: chunk.resultHead,
			contentHash: chunk.contentHash,
			file: chunk.bytes,
		});
		assertEventResponse(response, {
			generation: initialHead.generation,
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
	}
	return { head, uploaded: chunks.length > 0 };
}

async function replaceEventGeneration(
	input: {
		api: ApiClient;
		fence: SessionFence;
		session: RawSession;
		plan: SessionUploadPlan;
	},
	base: EventHead,
	events: readonly SessionEvent[],
	limits: { targetBytes: number; maxBytes: number },
): Promise<{ head: EventHead; uploaded: boolean }> {
	const finalHead = input.plan.finalEventHead;
	if (!finalHead) throw new Error("events-v1 plan is missing final head");
	const pendingShape = {
		kind: "rewrite" as const,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: events.length,
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
		append_id: pending.append_id,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: events.length,
		final_head_hash: finalHead,
	};
	const staged = await input.api.stageSessionEventGeneration(input.session.localSessionId, {
		environment_id: input.fence.environmentId,
		generation: pending.generation,
		append_id: pending.append_id,
		base_generation: base.generation,
		base_revision: base.revision,
		base_count: base.count,
		base_head_hash: base.head_hash,
		final_count: events.length,
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
			count: events.length,
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
	const heads = eventHeads(events);
	const chunks = chunkEvents(events, 0, limits, heads);
	for (const chunk of chunks) {
		const response = await input.api.uploadSessionEventGenerationChunk({
			localSessionId: input.session.localSessionId,
			generation: pending.generation,
			startSeq: chunk.startSeq,
			baseHeadHash: chunk.baseHead,
			contentHash: chunk.contentHash,
			file: chunk.bytes,
		});
		if (
			response.generation !== pending.generation ||
			response.start_seq !== chunk.startSeq ||
			response.end_seq !== chunk.startSeq + chunk.events.length - 1 ||
			response.count !== chunk.events.length ||
			response.content_hash !== chunk.contentHash ||
			response.result_head_hash !== chunk.resultHead
		) {
			throw new Error("server event chunk receipt does not match uploaded bytes");
		}
	}
	const committed = await input.api.commitSessionEventGeneration(
		input.session.localSessionId,
		pending.generation,
		commitBody,
	);
	assertEventResponse(committed, {
		generation: pending.generation,
		revision: base.revision + 1,
		count: events.length,
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
		uploaded: chunks.length > 0,
	};
}

function chunkEvents(
	events: readonly SessionEvent[],
	startSeq: number,
	limits: { targetBytes: number; maxBytes: number },
	heads: readonly string[],
): EventChunk[] {
	const chunks: EventChunk[] = [];
	let index = 0;
	while (index < events.length) {
		const chunkStartIndex = index;
		let size = 0;
		while (index < events.length) {
			const lineSize = Buffer.byteLength(`${canonicalJson(events[index])}\n`, "ascii");
			if (lineSize > limits.maxBytes) {
				throw new EventTooLargeError(startSeq + index, lineSize, limits.maxBytes);
			}
			if (index > chunkStartIndex && size + lineSize > limits.targetBytes) break;
			size += lineSize;
			index += 1;
		}
		const chunkStart = startSeq + chunkStartIndex;
		const selected = events.slice(chunkStartIndex, index);
		const bytes = encodeEventNdjson(selected);
		if (bytes.length > limits.maxBytes) {
			throw new EventTooLargeError(chunkStart, bytes.length, limits.maxBytes);
		}
		const baseHead = heads[chunkStart];
		const resultHead = heads[chunkStart + selected.length];
		if (!baseHead || !resultHead) throw new Error("events-v1 chunk head index is incomplete");
		chunks.push({
			startSeq: chunkStart,
			events: selected,
			bytes,
			contentHash: sha256(bytes),
			baseHead,
			resultHead,
		});
	}
	return chunks;
}

function eventHeads(events: readonly SessionEvent[]): string[] {
	const heads = [EMPTY_EVENT_HEAD];
	let head = EMPTY_EVENT_HEAD;
	for (const event of events) {
		head = advanceEventHead(head, [event]);
		heads.push(head);
	}
	return heads;
}

function assertEventSequence(events: readonly SessionEvent[]): void {
	for (let index = 0; index < events.length; index++) {
		const event = events[index];
		if (!event || event.seq !== index)
			throw new Error("events-v1 seq must be continuous from zero");
		const expectedId = createHash("sha256")
			.update(canonicalJson({ source: event.source, type: event.type }), "ascii")
			.digest("hex");
		if (event.event_id !== expectedId)
			throw new Error(`events-v1 event_id mismatch at seq ${index}`);
	}
}

function persistEventSuccess(
	input: { fence: SessionFence; session: RawSession; plan: SessionUploadPlan },
	head: EventHead,
): void {
	if (!head.generation) throw new Error("events-v1 success is missing generation");
	persistFencedSessionEntry(input.fence, {
		protocol: "events-v1",
		local_hash: input.plan.localHash,
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
		code: "legacy_session_too_large" | "event_too_large";
		sizeBytes: number;
		message: string;
	},
): SessionContentSyncResult {
	persistFencedSessionEntry(input.fence, {
		protocol: input.plan.protocol,
		local_hash: input.plan.localHash,
		...(input.plan.protocol === "snapshot-v1" ? { snapshot_hash: input.plan.localHash } : {}),
		blocked: {
			code: block.code,
			content_hash: input.plan.localHash,
			size_bytes: block.sizeBytes,
			message: block.message,
			blocked_at: new Date().toISOString(),
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
