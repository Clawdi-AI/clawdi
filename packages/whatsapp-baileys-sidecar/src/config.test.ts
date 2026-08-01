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

	it("loads the compatibility websocket override", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_PORT: "9876",
				CLAWDI_WA_WEBSOCKET_URL: "ws://127.0.0.1:3010/api/channels/whatsapp/x/baileys",
			});

			expect(config.port).toBe(9876);
			expect(config.sessionDir).toBe(sessionDir);
			expect(config.waWebSocketUrl).toBe("ws://127.0.0.1:3010/api/channels/whatsapp/x/baileys");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
