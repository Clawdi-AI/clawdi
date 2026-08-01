import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
	type CallbackDependencies,
	CallbackJournal,
	CallbackPermanentDeliveryError,
} from "./callback.js";
import type { NormalizedInboundMessage } from "./types.js";

describe("durable callback journal", () => {
	it("delivers one event at a time in order and treats every 2xx as accepted", async () => {
		await withSpool(async (spoolDir) => {
			const delivered: string[] = [];
			const queue = new CallbackJournal(
				config(spoolDir),
				logger(),
				() => {},
				dependencies(async (_url, init) => {
					const body = JSON.parse(String(init.body)) as NormalizedInboundMessage;
					delivered.push(body.messageId);
					return new Response(null, { status: body.messageId === "M1" ? 201 : 208 });
				}),
			);
			queue.enqueue(event("M1"));
			queue.enqueue(event("M2"));
			expect(queue.enqueue(event("M2"))).toBe(false);
			await queue.waitForIdle();
			expect(delivered).toEqual(["M1", "M2"]);
			expect(queue.pendingCount()).toBe(0);
			expect(readdirSync(spoolDir)).toEqual([]);
			await queue.stop();
		});
	});

	it("retries only retryable statuses and permanently fail-stops on 409", async () => {
		await withSpool(async (spoolDir) => {
			let attempts = 0;
			const retrying = new CallbackJournal(
				config(spoolDir),
				logger(),
				() => {},
				dependencies(async () => {
					attempts += 1;
					return new Response(null, { status: attempts === 1 ? 408 : 204 });
				}),
			);
			retrying.enqueue(event("M1"));
			await retrying.waitForIdle();
			expect(attempts).toBe(2);
			await retrying.stop();

			let fatal: Error | undefined;
			const permanent = new CallbackJournal(
				config(spoolDir),
				logger(),
				(error) => {
					fatal = error;
				},
				dependencies(async () => new Response(null, { status: 409 })),
			);
			permanent.enqueue(event("M2"));
			await expect(permanent.waitForIdle()).rejects.toBeInstanceOf(CallbackPermanentDeliveryError);
			expect(fatal).toBeInstanceOf(CallbackPermanentDeliveryError);
			expect(permanent.pendingCount()).toBe(1);
			await permanent.stop();
		});
	});

	it("recovers an atomically journaled event after restart and discards uncommitted temp files", async () => {
		await withSpool(async (spoolDir) => {
			const blocked = new CallbackJournal(
				config(spoolDir),
				logger(),
				() => {},
				dependencies(
					async (_url, init) =>
						await new Promise<Response>((_resolve, reject) => {
							init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							});
						}),
				),
			);
			blocked.enqueue(event("M1"));
			await Bun.sleep(5);
			await blocked.stop();
			writeFileSync(
				join(spoolDir, ".tmp-event-00000000000000000001.json-00000000-0000-4000-8000-000000000000"),
				"partial",
			);

			const delivered: string[] = [];
			const recovered = new CallbackJournal(
				config(spoolDir),
				logger(),
				() => {},
				dependencies(async (_url, init) => {
					delivered.push((JSON.parse(String(init.body)) as NormalizedInboundMessage).messageId);
					return new Response(null, { status: 200 });
				}),
			);
			await recovered.waitForIdle();
			expect(delivered).toEqual(["M1"]);
			expect(readdirSync(spoolDir)).toEqual([]);
			await recovered.stop();
		});
	});
});

function dependencies(fetchImpl: CallbackDependencies["fetch"]): CallbackDependencies {
	return {
		fetch: fetchImpl,
		random: () => 0,
		sleep: async (_milliseconds, signal) => {
			if (!signal.aborted) await Promise.resolve();
		},
	};
}

function config(spoolDir: string) {
	return {
		url: "https://callback.invalid/v1/events",
		token: "callback-token",
		spoolDir,
		maxPendingEvents: 10,
		maxPendingBytes: 1024 * 1024,
		initialBackoffMs: 1,
		maxBackoffMs: 2,
		requestTimeoutMs: 1000,
	};
}

function event(messageId: string): NormalizedInboundMessage {
	return {
		schemaVersion: "clawdi.whatsapp.sidecar-event.v1",
		providerEventId: `message:${messageId === "M1" ? "1" : "2".repeat(64)}`.replace(
			/^message:1$/,
			`message:${"1".repeat(64)}`,
		),
		accountId: "account-a",
		eventType: "message",
		messageId,
		chat: { primary: "15550001111@s.whatsapp.net" },
		actor: { primary: "15550001111@s.whatsapp.net" },
		fromMe: false,
		ownership: "peer",
		content: { type: "text", text: messageId },
	};
}

function logger() {
	return pino({ level: "silent" });
}

async function withSpool(run: (dir: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-wa-callback-"));
	const spool = join(root, "spool");
	mkdirSync(spool, { mode: 0o700 });
	try {
		await run(spool);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
