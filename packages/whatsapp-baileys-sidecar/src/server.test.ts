import { afterEach, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import type { BinaryNode } from "baileys";

import { createSidecarServer } from "./server.js";
import {
	type BaileysRuntime,
	QuotedMessageNotFoundError,
	type RelayMessageRequest,
	RuntimeNotConnectedError,
	type SendTextMessageRequest,
} from "./types.js";

class FakeRuntime implements BaileysRuntime {
	connected = true;
	relayRequests: RelayMessageRequest[] = [];
	rawNodes: BinaryNode[] = [];
	queries: Array<{ node: BinaryNode; timeoutMs: number }> = [];
	textMessages: SendTextMessageRequest[] = [];
	quotedMessageMissing = false;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	health() {
		return {
			status: this.connected ? "connected" : "disconnected",
			connected: this.connected,
			uptimeSeconds: 1,
		} as const;
	}

	async sendTextMessage(request: SendTextMessageRequest): Promise<{ messageId: string }> {
		if (!this.connected) {
			throw new RuntimeNotConnectedError();
		}
		if (this.quotedMessageMissing) throw new QuotedMessageNotFoundError();
		this.textMessages.push(request);
		return { messageId: "sent-1" };
	}

	async relayMessage(request: RelayMessageRequest): Promise<string> {
		if (!this.connected) {
			throw new RuntimeNotConnectedError();
		}
		this.relayRequests.push(request);
		return request.messageId;
	}

	async sendNode(node: BinaryNode): Promise<void> {
		if (!this.connected) {
			throw new RuntimeNotConnectedError();
		}
		this.rawNodes.push(node);
	}

	async query(node: BinaryNode, timeoutMs: number): Promise<BinaryNode> {
		if (!this.connected) {
			throw new RuntimeNotConnectedError();
		}
		this.queries.push({ node, timeoutMs });
		return {
			tag: "iq",
			attrs: { id: "response", type: "result" },
			content: Buffer.from([1, 2]),
		};
	}
}

const servers: Array<{ close(callback: () => void): void }> = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(resolve);
				}),
		),
	);
});

describe("sidecar HTTP contract", () => {
	it("requires bearer auth for every endpoint", async () => {
		const { url } = await startTestServer(new FakeRuntime());

		const response = await fetch(`${url}/v1/health`);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("reports health", async () => {
		const { url } = await startTestServer(new FakeRuntime());

		const response = await authedFetch(`${url}/v1/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "connected",
			connected: true,
			uptimeSeconds: 1,
		});
	});

	it("relays outbound proto messages with preserved attrs", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);

		const response = await authedFetch(`${url}/v1/relay-message`, {
			method: "POST",
			body: JSON.stringify({
				jid: "15551114444@s.whatsapp.net",
				messageId: "agent-edit-1",
				messageProtoBase64: Buffer.from([10, 4, 101, 100, 105, 116]).toString("base64"),
				additionalAttributes: {
					edit: "8",
					addressing_mode: "lid",
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, messageId: "agent-edit-1" });
		expect(runtime.relayRequests).toHaveLength(1);
		expect(runtime.relayRequests[0]).toEqual({
			jid: "15551114444@s.whatsapp.net",
			messageId: "agent-edit-1",
			messageProto: Buffer.from([10, 4, 101, 100, 105, 116]),
			additionalAttributes: {
				edit: "8",
				addressing_mode: "lid",
			},
		});
	});

	it("preserves final application text exactly with optional reply context", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);

		const response = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "120363012345678901@g.us",
				text: "  final answer\nsecond line\t ",
				messageId: "client-final-1",
				replyTo: {
					messageId: "inbound-1",
					participantJid: "15551114444@s.whatsapp.net",
				},
			}),
		});
		const retry = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "120363012345678901@g.us",
				text: "  final answer\nsecond line\t ",
				messageId: "client-final-1",
				replyTo: {
					messageId: "inbound-1",
					participantJid: "15551114444@s.whatsapp.net",
				},
			}),
		});

		expect(response.status).toBe(200);
		expect(retry.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, messageId: "sent-1" });
		expect(runtime.textMessages).toEqual([
			{
				jid: "120363012345678901@g.us",
				text: "  final answer\nsecond line\t ",
				messageId: "client-final-1",
				replyTo: {
					messageId: "inbound-1",
					participantJid: "15551114444@s.whatsapp.net",
				},
			},
			{
				jid: "120363012345678901@g.us",
				text: "  final answer\nsecond line\t ",
				messageId: "client-final-1",
				replyTo: {
					messageId: "inbound-1",
					participantJid: "15551114444@s.whatsapp.net",
				},
			},
		]);
	});

	it("rejects unsupported application JIDs, participants, and incomplete messages", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);

		const wrongJid = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "status@broadcast",
				text: "no",
				messageId: "client-1",
			}),
		});
		const legacyCUs = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "15551114444@c.us",
				text: "no legacy server",
				messageId: "client-c-us",
			}),
		});
		const emptyText = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "15551114444@s.whatsapp.net",
				text: " ",
				messageId: "client-2",
			}),
		});
		const missingMessageId = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ jid: "15551114444@s.whatsapp.net", text: "no id" }),
		});

		expect(wrongJid.status).toBe(400);
		expect(legacyCUs.status).toBe(400);
		expect(emptyText.status).toBe(400);
		expect(missingMessageId.status).toBe(400);
		expect(runtime.textMessages).toEqual([]);
	});

	it("fails closed when quoted content is absent from the local retry store", async () => {
		const runtime = new FakeRuntime();
		runtime.quotedMessageMissing = true;
		const { url } = await startTestServer(runtime);

		const response = await authedFetch(`${url}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({
				jid: "120363012345678901@g.us",
				text: "reply",
				messageId: "client-reply-missing",
				replyTo: {
					messageId: "missing-inbound",
					participantJid: "15551114444@s.whatsapp.net",
				},
			}),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "quoted_message_not_found" });
	});

	it("decodes raw node bytes and encodes IQ response bytes", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		const node = {
			tag: "message",
			attrs: { to: "15551114444@s.whatsapp.net" },
			content: [{ tag: "enc", attrs: {}, content: { $type: "base64-bytes", base64: "AQID" } }],
		};

		const rawResponse = await authedFetch(`${url}/v1/raw-node`, {
			method: "POST",
			body: JSON.stringify({ node }),
		});
		const iqResponse = await authedFetch(`${url}/v1/query-iq`, {
			method: "POST",
			body: JSON.stringify({
				node: { tag: "iq", attrs: { id: "q", type: "get" } },
				timeoutMs: 15000,
			}),
		});

		expect(rawResponse.status).toBe(200);
		expect(runtime.rawNodes).toEqual([
			{
				tag: "message",
				attrs: { to: "15551114444@s.whatsapp.net" },
				content: [{ tag: "enc", attrs: {}, content: Buffer.from([1, 2, 3]) }],
			},
		]);
		expect(iqResponse.status).toBe(200);
		expect(await iqResponse.json()).toEqual({
			node: {
				tag: "iq",
				attrs: { id: "response", type: "result" },
				content: { $type: "base64-bytes", base64: "AQI=" },
			},
		});
	});

	it("maps disconnected runtime to 503", async () => {
		const runtime = new FakeRuntime();
		runtime.connected = false;
		const { url } = await startTestServer(runtime);

		const response = await authedFetch(`${url}/v1/raw-node`, {
			method: "POST",
			body: JSON.stringify({ node: { tag: "presence", attrs: {} } }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "baileys_not_connected" });
	});
});

async function startTestServer(runtime: BaileysRuntime): Promise<{ url: string }> {
	const server = createSidecarServer(runtime, { apiToken: "test-token" });
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${address.port}` };
}

function authedFetch(url: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("authorization", "Bearer test-token");
	headers.set("content-type", "application/json");
	return fetch(url, { ...init, headers });
}
