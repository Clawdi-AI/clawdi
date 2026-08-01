import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv } from "./config.js";

describe("sidecar config", () => {
	it("requires explicit token and session dir", () => {
		expect(() => loadConfigFromEnv({})).toThrow("CLAWDI_WA_SIDECAR_TOKEN is required");
		expect(() => loadConfigFromEnv({ CLAWDI_WA_SIDECAR_TOKEN: "secret" })).toThrow(
			"CLAWDI_WA_SIDECAR_SESSION_DIR is required",
		);
	});

	it("loads auth cert and websocket override", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_PORT: "9876",
				CLAWDI_WA_WEBSOCKET_URL: "ws://127.0.0.1:3010/api/channels/whatsapp/x/baileys",
				CLAWDI_WA_AUTH_CERT_PUBKEY_BASE64: Buffer.from("cert").toString("base64"),
				CLAWDI_WA_AUTH_CERT_SERIAL: "12",
				CLAWDI_WA_AUTH_CERT_ISSUER: "clawdi-test",
			});

			expect(config.port).toBe(9876);
			expect(config.sessionDir).toBe(sessionDir);
			expect(config.waWebSocketUrl).toBe("ws://127.0.0.1:3010/api/channels/whatsapp/x/baileys");
			expect(config.authCert).toEqual({
				SERIAL: 12,
				ISSUER: "clawdi-test",
				PUBLIC_KEY: Buffer.from("cert"),
			});
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("loads the account-scoped callback without changing session ownership", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const spoolDir = mkdtempSync(join(tmpdir(), "clawdi-wa-spool-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_SIDECAR_TOKEN: "outbound-secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_ACCOUNT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
				CLAWDI_WA_SIDECAR_CALLBACK_URL:
					"http://127.0.0.1:8000/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events",
				CLAWDI_WA_SIDECAR_CALLBACK_TOKEN: "ingress-secret",
				CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR: spoolDir,
			});

			expect(config.sessionDir).toBe(sessionDir);
			expect(config.callback).toEqual({
				accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
				url: "http://127.0.0.1:8000/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events",
				token: "ingress-secret",
				spoolDir,
				maxPendingEvents: 1000,
				maxPendingBytes: 64 * 1024 * 1024,
				initialBackoffMs: 200,
				maxBackoffMs: 5000,
				requestTimeoutMs: 10000,
			});
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
			rmSync(spoolDir, { recursive: true, force: true });
		}
	});

	it("requires all account-scoped callback fields together", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
					CLAWDI_WA_SIDECAR_CALLBACK_URL: "http://127.0.0.1/callback",
				}),
			).toThrow("must be set together");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("binds the callback URL to the configured physical account", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const spoolDir = mkdtempSync(join(tmpdir(), "clawdi-wa-spool-"));
		const base = {
			CLAWDI_WA_SIDECAR_TOKEN: "secret",
			CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
			CLAWDI_WA_SIDECAR_ACCOUNT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			CLAWDI_WA_SIDECAR_CALLBACK_TOKEN: "ingress-secret",
			CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR: spoolDir,
		};
		try {
			for (const callbackUrl of [
				"http://127.0.0.1/v1/channels/whatsapp/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/sidecar/events",
				"http://user@127.0.0.1/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events",
				"http://127.0.0.1/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events?token=ambiguous",
				"http://127.0.0.1/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events#fragment",
			]) {
				expect(() =>
					loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_CALLBACK_URL: callbackUrl }),
				).toThrow("exact account callback path");
			}
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
			rmSync(spoolDir, { recursive: true, force: true });
		}
	});

	it("requires HTTPS except for exact loopback HTTP callback hosts", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const spoolDir = mkdtempSync(join(tmpdir(), "clawdi-wa-spool-"));
		const base = {
			CLAWDI_WA_SIDECAR_TOKEN: "secret",
			CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
			CLAWDI_WA_SIDECAR_ACCOUNT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
			CLAWDI_WA_SIDECAR_CALLBACK_TOKEN: "ingress-secret",
			CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR: spoolDir,
		};
		const path = "/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events";
		try {
			expect(() =>
				loadConfigFromEnv({
					...base,
					CLAWDI_WA_SIDECAR_CALLBACK_URL: `http://backend.example.test${path}`,
				}),
			).toThrow("must use HTTPS");
			expect(
				loadConfigFromEnv({
					...base,
					CLAWDI_WA_SIDECAR_CALLBACK_URL: `https://backend.example.test${path}`,
				}).callback?.url,
			).toBe(`https://backend.example.test${path}`);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
			rmSync(spoolDir, { recursive: true, force: true });
		}
	});

	it("keeps callback spool storage outside the provider auth session tree", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
					CLAWDI_WA_SIDECAR_ACCOUNT_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
					CLAWDI_WA_SIDECAR_CALLBACK_URL:
						"http://127.0.0.1/v1/channels/whatsapp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/sidecar/events",
					CLAWDI_WA_SIDECAR_CALLBACK_TOKEN: "ingress-secret",
					CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR: join(sessionDir, "callback-spool"),
				}),
			).toThrow("must be separate");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
