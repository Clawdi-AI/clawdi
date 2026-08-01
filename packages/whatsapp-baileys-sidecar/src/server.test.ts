import { afterEach, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";

import { BAILEYS_RELEASE } from "./release.js";
import { createSidecarServer } from "./server.js";
import type {
	BaileysRuntime,
	MediaDownload,
	OperationResult,
	PairingStatus,
	SidecarOperation,
} from "./types.js";
import {
	AccountResetBlockedError,
	LoggedOutResetNotAllowedError,
	LoggedOutResetRequiredError,
} from "./types.js";

class FakeRuntime implements BaileysRuntime {
	operations: Array<{ operation: SidecarOperation; hash: string }> = [];
	recoveries: Array<{ acceptVersionChange: boolean; resetLoggedOut: boolean }> = [];
	recoverError: Error | undefined;
	pairingSecret: string | undefined;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	health() {
		return {
			status: "connected",
			connected: true,
			uptimeSeconds: 1,
			accountId: "account-a",
			advertisedRelease: BAILEYS_RELEASE,
			versionRecoveryRequired: false,
			registered: false,
			callback: { enabled: true, pendingEvents: 0 },
		} as const;
	}
	capabilities() {
		return {
			schemaVersion: "clawdi.whatsapp.sidecar-capabilities.v1",
			operations: ["send", "edit", "delete", "reaction", "presence", "read"],
			pairing: ["qr", "code", "cancel", "logout", "recover"],
			mediaDownload: true,
			callbackDelivery: true,
			jidKinds: ["pn", "lid", "group"],
			rawProviderAccess: false,
		} as const;
	}
	pairingStatus(): PairingStatus {
		return {
			status: this.pairingSecret ? "pairing_code" : "starting",
			registered: false,
			...(this.pairingSecret ? { method: "code" as const, code: this.pairingSecret } : {}),
		};
	}
	async startQrPairing(): Promise<PairingStatus> {
		return { status: "pairing_qr", registered: false, method: "qr", qr: "QR-SECRET" };
	}
	async startCodePairing(_phoneNumber: string): Promise<PairingStatus> {
		this.pairingSecret = "CODE-SECRET";
		return this.pairingStatus();
	}
	async cancelPairing(): Promise<PairingStatus> {
		this.pairingSecret = undefined;
		return { status: "stopped", registered: false };
	}
	async logout(): Promise<PairingStatus> {
		return { status: "stopped", registered: false };
	}
	async recover(acceptVersionChange: boolean, resetLoggedOut = false): Promise<void> {
		this.recoveries.push({ acceptVersionChange, resetLoggedOut });
		if (this.recoverError) throw this.recoverError;
	}
	async performOperation(operation: SidecarOperation, hash: string): Promise<OperationResult> {
		this.operations.push({ operation, hash });
		return { operationId: operation.operationId, status: "completed", messageId: "BACKEND-M1" };
	}
	async downloadMedia(_mediaId: string): Promise<MediaDownload> {
		return { data: Buffer.from([1, 2, 3]), contentType: "image/jpeg" };
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
	it("requires bearer auth on health, pairing, operations, and media", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		for (const [path, method] of [
			["/v1/health", "GET"],
			["/v1/pairing/status", "GET"],
			["/v1/operations", "POST"],
			[`/v1/media/media_${"a".repeat(43)}`, "GET"],
		] as const) {
			const response = await fetch(`${url}${path}`, { method });
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
		}
	});

	it("reports the pinned release and honest capabilities without pairing secrets", async () => {
		const runtime = new FakeRuntime();
		runtime.pairingSecret = "CODE-SECRET";
		const { url } = await startTestServer(runtime);
		const health = await authedFetch(`${url}/v1/health`);
		const healthText = await health.text();
		expect(healthText).toContain("7.0.0-rc13");
		expect(healthText).not.toContain("CODE-SECRET");
		const capabilities = await authedFetch(`${url}/v1/capabilities`);
		expect(await capabilities.json()).toMatchObject({ rawProviderAccess: false });
	});

	it("accepts only explicit logged-out recovery and maps recovery policy conflicts", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		const accepted = await authedFetch(`${url}/v1/recover`, {
			method: "POST",
			body: JSON.stringify({ acceptVersionChange: false, resetLoggedOut: true }),
		});
		expect(accepted.status).toBe(200);
		expect(runtime.recoveries).toEqual([{ acceptVersionChange: false, resetLoggedOut: true }]);

		for (const body of [
			{ resetLoggedOut: "yes" },
			{ acceptVersionChange: false, resetLoggedOut: false, resetAllAuth: true },
		]) {
			const denied = await authedFetch(`${url}/v1/recover`, {
				method: "POST",
				body: JSON.stringify(body),
			});
			expect(denied.status).toBe(400);
		}

		runtime.recoverError = new LoggedOutResetRequiredError();
		const required = await authedFetch(`${url}/v1/recover`, {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(required.status).toBe(409);
		expect(await required.json()).toEqual({ error: "logged_out_reset_required" });
		runtime.recoverError = new LoggedOutResetNotAllowedError();
		const notAllowed = await authedFetch(`${url}/v1/recover`, {
			method: "POST",
			body: JSON.stringify({ resetLoggedOut: true }),
		});
		expect(notAllowed.status).toBe(409);
		expect(await notAllowed.json()).toEqual({ error: "logged_out_reset_not_allowed" });
		runtime.recoverError = new AccountResetBlockedError();
		const pendingCallbacks = await authedFetch(`${url}/v1/recover`, {
			method: "POST",
			body: JSON.stringify({ resetLoggedOut: true }),
		});
		expect(pendingCallbacks.status).toBe(409);
		expect(await pendingCallbacks.json()).toEqual({
			error: "account_reset_pending_callbacks",
		});
	});

	it("accepts only the typed operation contract and preserves the stable send message id", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		const response = await authedFetch(`${url}/v1/operations`, {
			method: "POST",
			body: JSON.stringify(sendBody()),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			operationId: "op-1",
			status: "completed",
			messageId: "BACKEND-M1",
		});
		expect(runtime.operations[0]?.operation).toMatchObject({
			type: "send",
			messageId: "BACKEND-M1",
			chatJid: "15550001111@s.whatsapp.net",
		});
		expect(runtime.operations[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("denies hosted, broadcast, newsletter, global, raw, and proto operations", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		for (const chatJid of [
			"15550001111@hosted",
			"15550001111@hosted.lid",
			"status@broadcast",
			"123@newsletter",
			"@s.whatsapp.net",
		]) {
			const response = await authedFetch(`${url}/v1/operations`, {
				method: "POST",
				body: JSON.stringify({ ...sendBody(), chatJid }),
			});
			expect(response.status).toBe(400);
		}
		for (const path of ["/v1/relay-message", "/v1/raw-node", "/v1/query-iq", "/v1/proto"]) {
			const response = await authedFetch(`${url}${path}`, { method: "POST", body: "{}" });
			expect(response.status).toBe(404);
		}
		for (const presence of ["available", "unavailable"]) {
			const response = await authedFetch(`${url}/v1/operations`, {
				method: "POST",
				body: JSON.stringify({
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: `global-presence-${presence}`,
					chatJid: "15550001111@s.whatsapp.net",
					type: "presence",
					presence,
				}),
			});
			expect(response.status).toBe(400);
		}
		expect(runtime.operations).toHaveLength(0);
	});

	it("validates group/message alias conflicts and pairing E.164 boundaries", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		const conflict = await authedFetch(`${url}/v1/operations`, {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: "clawdi.whatsapp.operation.v1",
				operationId: "op-read",
				chatJid: "120363000000001@g.us",
				type: "read",
				messages: [
					{
						messageId: "M1",
						fromMe: false,
						chatJid: "120363000000001@g.us",
						chatJidAlt: "15550001111@s.whatsapp.net",
					},
				],
			}),
		});
		expect(conflict.status).toBe(400);
		for (const phoneNumber of ["+15550001111", "01234567", "123456", "1234567890123456"]) {
			const response = await authedFetch(`${url}/v1/pairing/code`, {
				method: "POST",
				body: JSON.stringify({ phoneNumber }),
			});
			expect(response.status).toBe(400);
		}
		const accepted = await authedFetch(`${url}/v1/pairing/code`, {
			method: "POST",
			body: JSON.stringify({ phoneNumber: "15550001111" }),
		});
		expect(await accepted.json()).toMatchObject({ code: "CODE-SECRET" });
	});

	it("allows mutations only for owned messages and requires group peer participants", async () => {
		const runtime = new FakeRuntime();
		const { url } = await startTestServer(runtime);
		for (const type of ["edit", "delete"] as const) {
			const response = await authedFetch(`${url}/v1/operations`, {
				method: "POST",
				body: JSON.stringify({
					schemaVersion: "clawdi.whatsapp.operation.v1",
					operationId: `op-${type}`,
					chatJid: "15550001111@s.whatsapp.net",
					type,
					messageId: `M-${type}`,
					target: { messageId: "PEER-1", fromMe: false },
					...(type === "edit" ? { text: "edited" } : {}),
				}),
			});
			expect(response.status).toBe(400);
		}

		const ambiguousGroupReaction = await authedFetch(`${url}/v1/operations`, {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: "clawdi.whatsapp.operation.v1",
				operationId: "op-group-reaction",
				chatJid: "120363000000001@g.us",
				type: "reaction",
				messageId: "REACTION-1",
				target: { messageId: "PEER-1", fromMe: false },
				reaction: "👍",
			}),
		});
		expect(ambiguousGroupReaction.status).toBe(400);

		const exactGroupReaction = await authedFetch(`${url}/v1/operations`, {
			method: "POST",
			body: JSON.stringify({
				schemaVersion: "clawdi.whatsapp.operation.v1",
				operationId: "op-group-reaction-exact",
				chatJid: "120363000000001@g.us",
				type: "reaction",
				messageId: "REACTION-2",
				target: {
					messageId: "PEER-1",
					fromMe: false,
					participantJid: "15550001111@s.whatsapp.net",
				},
				reaction: "👍",
			}),
		});
		expect(exactGroupReaction.status).toBe(200);
		expect(runtime.operations).toHaveLength(1);
	});

	it("serves only opaque persisted media ids with a bounded binary response", async () => {
		const { url } = await startTestServer(new FakeRuntime());
		const denied = await authedFetch(`${url}/v1/media/not-a-provider-id`);
		expect(denied.status).toBe(404);
		const response = await authedFetch(`${url}/v1/media/media_${"a".repeat(43)}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
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
	if (init.body) headers.set("content-type", "application/json");
	return fetch(url, { ...init, headers });
}

function sendBody() {
	return {
		schemaVersion: "clawdi.whatsapp.operation.v1",
		operationId: "op-1",
		chatJid: "15550001111@s.whatsapp.net",
		type: "send",
		messageId: "BACKEND-M1",
		content: { type: "text", text: "hello" },
	};
}
