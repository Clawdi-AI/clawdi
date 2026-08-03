import type { AddressInfo } from "node:net";
import type { BinaryNode } from "baileys";
import { afterEach, describe, expect, it } from "vitest";
import { AUDITED_PROVIDER_RELEASE } from "./audited-version.js";
import { createSidecarServer, type SidecarSessionService } from "./server.js";
import type { ProviderMessageEvent } from "./sqlite-state.js";
import {
	type BaileysRuntime,
	type PairingStatus,
	type RelayMessageRequest,
	RuntimeNotConnectedError,
} from "./types.js";

class FakeRuntime implements BaileysRuntime {
	connected = true;
	relayRequests: RelayMessageRequest[] = [];
	rawNodes: BinaryNode[] = [];
	queries: Array<{ node: BinaryNode; timeoutMs: number }> = [];
	providerInbox: ProviderMessageEvent[] = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	health() {
		return {
			status: this.connected ? "connected" : "disconnected",
			connected: this.connected,
			registered: true,
			sessionId: "11111111-1111-4111-8111-111111111111",
			advertisedRelease: {
				packageName: "@whiskeysockets/baileys",
				packageVersion: "7.0.0-rc14",
				sourceCommit: "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
				version: [2, 3000, 1_043_857_760],
			},
			uptimeSeconds: 1,
		} as const;
	}

	capabilities() {
		return {
			schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1",
			pairing: ["qr", "code", "cancel", "logout", "retry"],
			rawProviderAccess: false,
		} as const;
	}

	pairingStatus(): PairingStatus {
		return { status: this.connected ? "connected" : "disconnected", registered: true };
	}

	async startQrPairing(): Promise<PairingStatus> {
		return {
			status: "pairing_qr",
			registered: false,
			method: "qr",
			qr: "sensitive-qr",
			qrExpiresAt: "2026-08-02T12:00:00.000Z",
		};
	}

	async requestPairingCode(_phoneNumber: string): Promise<PairingStatus> {
		return { status: "pairing_code", registered: false, method: "code", code: "12345678" };
	}

	async cancelPairing(): Promise<PairingStatus> {
		return { status: "stopped", registered: false };
	}

	async logoutPairing(): Promise<PairingStatus> {
		return { status: "stopped", registered: false };
	}

	async retryPairing(): Promise<PairingStatus> {
		return this.pairingStatus();
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

	providerEvents(limit: number): ProviderMessageEvent[] {
		return this.providerInbox.slice(0, limit);
	}

	acknowledgeProviderEvents(throughSequence: number): void {
		this.providerInbox = this.providerInbox.filter((event) => event.sequence > throughSequence);
	}
}

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_PREFIX = `/v1/sessions/${ACCOUNT_ID}`;

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
	it("rejects unsupported session routes before starting a runtime", async () => {
		const runtime = new FakeRuntime();
		let sessionStarts = 0;
		const supervisor: SidecarSessionService = {
			health: () => ({
				schemaVersion: "clawdi.whatsapp.sidecar-health.v1",
				ready: true,
				activeSessions: 0,
				advertisedRelease: AUDITED_PROVIDER_RELEASE,
			}),
			capabilities: () => runtime.capabilities(),
			async session() {
				sessionStarts += 1;
				return runtime;
			},
		};
		const server = createSidecarServer(supervisor, { apiToken: "test-token" });
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const url = `http://127.0.0.1:${address.port}`;

		const wrongMethod = await authedFetch(`${url}${SESSION_PREFIX}/health`, {
			method: "POST",
		});
		const unknownRoute = await authedFetch(`${url}${SESSION_PREFIX}/unknown`);

		expect(wrongMethod.status).toBe(404);
		expect(unknownRoute.status).toBe(404);
		expect(sessionStarts).toBe(0);
	});

	it("requires bearer auth for every pairing endpoint", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		const requests: Array<[string, RequestInit | undefined]> = [
			["/v1/capabilities", undefined],
			[`${SESSION_PREFIX}/pairing/status`, undefined],
			[`${SESSION_PREFIX}/pairing/qr`, { method: "POST" }],
			[
				`${SESSION_PREFIX}/pairing/code`,
				{ method: "POST", body: JSON.stringify({ phoneNumber: "15551234567" }) },
			],
			[`${SESSION_PREFIX}/pairing/cancel`, { method: "POST" }],
			[`${SESSION_PREFIX}/pairing/logout`, { method: "POST" }],
			[`${SESSION_PREFIX}/pairing/retry`, { method: "POST" }],
		];

		for (const [path, init] of requests) {
			const response = await fetch(`${url}${path}`, init);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
	});

	it("serves the complete no-store pairing lifecycle contract", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		const requests: Array<[string, RequestInit | undefined]> = [
			["/v1/capabilities", undefined],
			[`${SESSION_PREFIX}/pairing/status`, undefined],
			[`${SESSION_PREFIX}/pairing/qr`, { method: "POST" }],
			[
				`${SESSION_PREFIX}/pairing/code`,
				{ method: "POST", body: JSON.stringify({ phoneNumber: "15551234567" }) },
			],
			[`${SESSION_PREFIX}/pairing/cancel`, { method: "POST" }],
			[`${SESSION_PREFIX}/pairing/logout`, { method: "POST" }],
			[`${SESSION_PREFIX}/pairing/retry`, { method: "POST" }],
		];

		for (const [path, init] of requests) {
			const response = await authedFetch(`${url}${path}`, init);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-store, private");
			expect(response.headers.get("pragma")).toBe("no-cache");
		}
	});

	it("validates pairing-code phone input without echoing it", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		const phoneNumber = "+1 (555) 123-4567";

		const response = await authedFetch(`${url}${SESSION_PREFIX}/pairing/code`, {
			method: "POST",
			body: JSON.stringify({ phoneNumber }),
		});
		const body = await response.text();

		expect(response.status).toBe(422);
		expect(body).not.toContain(phoneNumber);
		expect(body).not.toContain("15551234567");
		expect(body).toBe('{"error":"invalid_phone_number"}');
	});

	it("reports health", async () => {
		const { url } = await startTestServer(new FakeRuntime());

		const response = await authedFetch(`${url}${SESSION_PREFIX}/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "connected",
			connected: true,
			registered: true,
			sessionId: "11111111-1111-4111-8111-111111111111",
			advertisedRelease: {
				packageName: "@whiskeysockets/baileys",
				packageVersion: "7.0.0-rc14",
				sourceCommit: "7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a",
				version: [2, 3000, 1_043_857_760],
			},
			uptimeSeconds: 1,
		});
		expect(response.headers.get("cache-control")).toBe("no-store, private");
	});

	it("relays outbound proto messages with preserved attrs", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);

		const response = await authedFetch(`${url}${SESSION_PREFIX}/relay-message`, {
			method: "POST",
			body: JSON.stringify({
				jid: "15551114444@s.whatsapp.net",
				messageId: "agent-edit-1",
				messageProtoBase64: Buffer.from([10, 4, 101, 100, 105, 116]).toString("base64"),
				additionalAttributes: {
					edit: "8",
					addressing_mode: "lid",
				},
				additionalNodes: [{ tag: "meta", attrs: { polltype: "creation" } }],
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
			additionalNodes: [{ tag: "meta", attrs: { polltype: "creation" } }],
		});
	});

	it("rejects broad relay additional nodes", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		for (const additionalNodes of [
			[{ tag: "meta", attrs: { event_type: "creation" } }],
			[{ tag: "participants", attrs: {} }],
			[{ tag: "device-identity", attrs: {} }],
		]) {
			const response = await authedFetch(`${url}${SESSION_PREFIX}/relay-message`, {
				method: "POST",
				body: JSON.stringify({
					jid: "15551114444@s.whatsapp.net",
					messageId: "agent-unsafe-1",
					messageProtoBase64: "CgF4",
					additionalAttributes: {},
					additionalNodes,
				}),
			});
			expect(response.status).toBe(400);
		}
		expect(runtime.relayRequests).toEqual([]);
	});

	it("decodes raw node bytes and encodes IQ response bytes", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		const node = {
			tag: "message",
			attrs: { to: "15551114444@s.whatsapp.net" },
			content: [{ tag: "enc", attrs: {}, content: { $type: "base64-bytes", base64: "AQID" } }],
		};

		const rawResponse = await authedFetch(`${url}${SESSION_PREFIX}/raw-node`, {
			method: "POST",
			body: JSON.stringify({ node }),
		});
		const iqResponse = await authedFetch(`${url}${SESSION_PREFIX}/query-iq`, {
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

		const response = await authedFetch(`${url}${SESSION_PREFIX}/raw-node`, {
			method: "POST",
			body: JSON.stringify({ node: { tag: "presence", attrs: {} } }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "baileys_not_connected" });
	});

	it("lists and acknowledges durable provider events", async () => {
		const runtime = new FakeRuntime();
		runtime.providerInbox = [
			{
				sequence: 1,
				eventType: "messages.upsert",
				messageId: "provider-1",
				remoteJid: "15551114444@s.whatsapp.net",
				fromMe: false,
				messageProtoBase64: "CgVoZWxsbw==",
			},
		];
		const { url } = await startTestServer(runtime);

		const listed = await authedFetch(`${url}${SESSION_PREFIX}/provider-events?limit=10`);
		const listedBody = await listed.json();
		const acknowledged = await authedFetch(`${url}${SESSION_PREFIX}/provider-events/ack`, {
			method: "POST",
			body: JSON.stringify({ throughSequence: 1 }),
		});

		expect(listed.status).toBe(200);
		expect(listedBody).toEqual({
			events: [
				{
					sequence: 1,
					eventType: "messages.upsert",
					messageId: "provider-1",
					remoteJid: "15551114444@s.whatsapp.net",
					fromMe: false,
					messageProtoBase64: "CgVoZWxsbw==",
				},
			],
		});
		expect(acknowledged.status).toBe(200);
		expect(await acknowledged.json()).toEqual({ ok: true, throughSequence: 1 });
		expect(runtime.providerInbox).toEqual([]);
	});
});

async function startTestServer(runtime: BaileysRuntime): Promise<{ url: string }> {
	const supervisor: SidecarSessionService = {
		health: () => ({
			schemaVersion: "clawdi.whatsapp.sidecar-health.v1",
			ready: true,
			activeSessions: 1,
			advertisedRelease: AUDITED_PROVIDER_RELEASE,
		}),
		capabilities: () => runtime.capabilities(),
		async session(sessionId) {
			if (sessionId !== ACCOUNT_ID) throw new Error("unexpected test session");
			await runtime.start();
			return runtime;
		},
	};
	const server = createSidecarServer(supervisor, { apiToken: "test-token" });
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
