import { expect, test } from "bun:test";
import { createWhatsAppClient } from "./whatsapp-client";
import { redactWhatsAppSession, type WhatsAppSession } from "./whatsapp-onboarding";

const session: WhatsAppSession = {
	id: "session",
	name: "Work",
	state: "ready",
	method: "qr",
	qr: "sensitive-qr",
	qr_expires_at: "2026-10-03T15:00:00Z",
	pairing_code: "sensitive-code",
	manual_pairing_code_supported: true,
	started_at: "2026-10-03T14:00:00Z",
	expires_at: "2026-10-03T15:00:00Z",
};

test("background redaction retains recovery identity but no QR or pairing secret", () => {
	const safe = redactWhatsAppSession(session);
	expect(safe).toEqual({ ...session, qr: null, qr_expires_at: null, pairing_code: null });
	expect(session.qr).toBe("sensitive-qr");
});

test("uncertain starts never auto-retry; explicit recovery preserves the original request", async () => {
	const bodies: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			expect(request.headers.get("authorization")).toBe("Bearer fixture");
			expect(new URL(request.url).pathname).toBe("/v1/channels/whatsapp/onboarding/sessions");
			bodies.push(await request.json());
			return bodies.length === 1
				? Response.json({ detail: "unavailable" }, { status: 503 })
				: Response.json(session);
		},
	});
	try {
		const client = createWhatsAppClient({
			baseUrl: server.url.href,
			getToken: async () => "fixture",
			fetch,
		});
		const key = "f074c6eb-58f0-48da-b55e-ef0b72e04d6b";
		await expect(client.start(key, "Work")).rejects.toMatchObject({ status: 503 });
		expect(bodies).toHaveLength(1);
		expect(await client.start(key, "Work")).toEqual(session);
		expect(bodies).toEqual(Array(2).fill({ request_id: key, name: "Work" }));
	} finally {
		server.stop(true);
	}
});

test("malformed phone/start values fail before auth; another session or repaired account cannot be accepted", async () => {
	let tokens = 0;
	const client = createWhatsAppClient({
		baseUrl: "https://cloud.example",
		getToken: async () => {
			tokens++;
			return "fixture";
		},
		fetch: async () => Response.json(session),
	});
	for (const phone of ["", "+14155550123", "04155550123", "123456", "1234567890123456"])
		await expect(client.pairingCode("session", phone)).rejects.toMatchObject({ status: 400 });
	await expect(client.start("invalid", "Work")).rejects.toMatchObject({ status: 400 });
	expect(tokens).toBe(0);
	await expect(client.get("another-session")).rejects.toThrow("API response could not be read");
	await expect(client.repair("another-account")).rejects.toThrow("API response could not be read");
});
