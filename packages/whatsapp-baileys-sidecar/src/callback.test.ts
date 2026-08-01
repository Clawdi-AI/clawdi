import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";

import {
	type CallbackDeliveryConfig,
	CallbackQueueFullError,
	CallbackSpoolCorruptionError,
	ClawdiCallbackDeliveryQueue,
} from "./callback.js";
import type { NormalizedInboundMessage } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function event(id: string): NormalizedInboundMessage {
	return {
		schemaVersion: "clawdi.whatsapp.sidecar-event.v1",
		providerEventId: `message:${id}`,
		messageId: id,
		chatJid: "15551114444@s.whatsapp.net",
		actorJid: "15551114444@s.whatsapp.net",
		fromMe: false,
		text: `hello ${id}`,
	};
}

function spoolDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-wa-spool-"));
	tempDirs.push(directory);
	return directory;
}

function config(
	directory: string,
	overrides: Partial<CallbackDeliveryConfig> = {},
): CallbackDeliveryConfig {
	return {
		url: "http://clawdi.test/callback",
		token: "sidecar-ingress",
		spoolDir: directory,
		maxPendingEvents: 10,
		maxPendingBytes: 64 * 1024,
		initialBackoffMs: 1,
		maxBackoffMs: 10,
		requestTimeoutMs: 1000,
		...overrides,
	};
}

function journal(events: NormalizedInboundMessage[]): string {
	return JSON.stringify({
		schemaVersion: "clawdi.whatsapp.callback-spool.v1",
		events,
	});
}

describe("Clawdi durable callback delivery", () => {
	it("keeps the durable head until Clawdi accepts it and then deletes it", async () => {
		const directory = spoolDir();
		const requests: string[] = [];
		const delays: number[] = [];
		const queue = new ClawdiCallbackDeliveryQueue(config(directory), pino({ level: "silent" }), {
			fetch: async (_url, init) => {
				requests.push(String(init?.body));
				return new Response(null, { status: requests.length < 4 ? 503 : 200 });
			},
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});

		queue.enqueue(event("1"));
		await queue.waitForIdle();

		expect(requests.map((body) => JSON.parse(body))).toEqual([
			event("1"),
			event("1"),
			event("1"),
			event("1"),
		]);
		expect(delays).toEqual([1, 2, 4]);
		expect(queue.pendingCount()).toBe(0);
		expect(queue.pendingBytes()).toBe(0);
		expect(readdirSync(directory)).toEqual([]);
		expect(await queue.stop()).toBe(0);
	});

	it("retains an in-flight head on shutdown and recovers it after restart", async () => {
		const directory = spoolDir();
		const first = new ClawdiCallbackDeliveryQueue(config(directory), pino({ level: "silent" }), {
			fetch: async (_url, init) => {
				await new Promise<void>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				});
				return new Response(null, { status: 200 });
			},
			sleep: async () => {},
		});
		first.enqueueBatch([event("restart-1"), event("restart-2")]);

		expect(await first.stop()).toBe(2);
		expect(readdirSync(directory)).toEqual(["batch-00000000000000000001.json"]);

		const delivered: string[] = [];
		const recovered = new ClawdiCallbackDeliveryQueue(
			config(directory),
			pino({ level: "silent" }),
			{
				fetch: async (_url, init) => {
					delivered.push((JSON.parse(String(init?.body)) as { messageId: string }).messageId);
					return new Response(null, { status: 200 });
				},
				sleep: async () => {},
			},
		);
		await recovered.waitForIdle();

		expect(delivered).toEqual(["restart-1", "restart-2"]);
		expect(readdirSync(directory)).toEqual([]);
		expect(await recovered.stop()).toBe(0);
	});

	it("uses recovered monotonic sequences to preserve multi-batch order", async () => {
		const directory = spoolDir();
		const blockedFetch = async (_url: string, init?: RequestInit) => {
			await new Promise<void>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
			return new Response(null, { status: 200 });
		};
		const first = new ClawdiCallbackDeliveryQueue(config(directory), pino({ level: "silent" }), {
			fetch: blockedFetch,
			sleep: async () => {},
		});
		first.enqueue(event("ordered-1"));
		first.enqueue(event("ordered-2"));
		first.enqueue(event("ordered-3"));
		expect(await first.stop()).toBe(3);
		expect(readdirSync(directory).sort()).toEqual([
			"batch-00000000000000000001.json",
			"batch-00000000000000000002.json",
			"batch-00000000000000000003.json",
		]);

		const delivered: string[] = [];
		const recovered = new ClawdiCallbackDeliveryQueue(
			config(directory),
			pino({ level: "silent" }),
			{
				fetch: async (_url, init) => {
					delivered.push((JSON.parse(String(init?.body)) as { messageId: string }).messageId);
					return new Response(null, { status: 200 });
				},
				sleep: async () => {},
			},
		);
		await recovered.waitForIdle();

		expect(delivered).toEqual(["ordered-1", "ordered-2", "ordered-3"]);
		expect(await recovered.stop()).toBe(0);
	});

	it("rejects an oversized batch atomically without crossing either hard cap", async () => {
		const directory = spoolDir();
		const queue = new ClawdiCallbackDeliveryQueue(
			config(directory, { maxPendingEvents: 1, maxPendingBytes: 64 }),
			pino({ level: "silent" }),
			{ fetch: async () => new Response(null, { status: 200 }), sleep: async () => {} },
		);

		expect(() => queue.enqueueBatch([event("one"), event("two")])).toThrow(CallbackQueueFullError);
		expect(() => queue.enqueue(event("one-large-event"))).toThrow(CallbackQueueFullError);
		expect(queue.pendingCount()).toBe(0);
		expect(queue.pendingBytes()).toBe(0);
		expect(readdirSync(directory)).toEqual([]);
		expect(await queue.stop()).toBe(0);
	});

	it("fails visibly on corrupt or ambiguous spool state", () => {
		const corrupt = spoolDir();
		writeFileSync(join(corrupt, "batch-00000000000000000001.json"), "not-json");
		expect(
			() => new ClawdiCallbackDeliveryQueue(config(corrupt), pino({ level: "silent" })),
		).toThrow(CallbackSpoolCorruptionError);

		const ambiguous = spoolDir();
		const target = "batch-00000000000000000001.json";
		writeFileSync(
			join(ambiguous, `.tmp-${target}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`),
			journal([event("a")]),
		);
		writeFileSync(
			join(ambiguous, `.tmp-${target}-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`),
			journal([event("b")]),
		);
		expect(
			() => new ClawdiCallbackDeliveryQueue(config(ambiguous), pino({ level: "silent" })),
		).toThrow("ambiguous callback spool temporary files");
	});

	it("recovers valid atomic-write temp files without discarding a committed target", async () => {
		const completed = spoolDir();
		const target = "batch-00000000000000000001.json";
		writeFileSync(
			join(completed, `.tmp-${target}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`),
			journal([event("temp-only")]),
		);
		const completedDeliveries: string[] = [];
		const completedQueue = new ClawdiCallbackDeliveryQueue(
			config(completed),
			pino({ level: "silent" }),
			{
				fetch: async (_url, init) => {
					completedDeliveries.push(
						(JSON.parse(String(init?.body)) as { messageId: string }).messageId,
					);
					return new Response(null, { status: 200 });
				},
				sleep: async () => {},
			},
		);
		await completedQueue.waitForIdle();
		expect(completedDeliveries).toEqual(["temp-only"]);
		expect(await completedQueue.stop()).toBe(0);

		const committed = spoolDir();
		writeFileSync(join(committed, target), journal([event("committed-old-head")]));
		writeFileSync(
			join(committed, `.tmp-${target}-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`),
			journal([event("uncommitted-rewrite")]),
		);
		const committedDeliveries: string[] = [];
		const committedQueue = new ClawdiCallbackDeliveryQueue(
			config(committed),
			pino({ level: "silent" }),
			{
				fetch: async (_url, init) => {
					committedDeliveries.push(
						(JSON.parse(String(init?.body)) as { messageId: string }).messageId,
					);
					return new Response(null, { status: 200 });
				},
				sleep: async () => {},
			},
		);
		await committedQueue.waitForIdle();
		expect(committedDeliveries).toEqual(["committed-old-head"]);
		expect(await committedQueue.stop()).toBe(0);
	});

	it("keeps a valid temp for operator recovery when the existing target is corrupt", () => {
		const directory = spoolDir();
		const target = "batch-00000000000000000001.json";
		const temp = `.tmp-${target}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
		writeFileSync(join(directory, target), "not-json");
		writeFileSync(join(directory, temp), journal([event("recoverable-temp")]));

		expect(
			() => new ClawdiCallbackDeliveryQueue(config(directory), pino({ level: "silent" })),
		).toThrow(CallbackSpoolCorruptionError);
		expect(readdirSync(directory).sort()).toEqual([temp, target].sort());
	});
});
