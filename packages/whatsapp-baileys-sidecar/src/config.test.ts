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
});
