import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv } from "./config.js";

describe("sidecar config", () => {
	it("requires explicit token and session dir", () => {
		expect(() => loadConfigFromEnv({})).toThrow("CLAWDI_WA_PROVIDER_ACCOUNT_ID is required");
		expect(() => loadConfigFromEnv({ CLAWDI_WA_PROVIDER_ACCOUNT_ID: "account-a" })).toThrow(
			"CLAWDI_WA_SIDECAR_TOKEN is required",
		);
		expect(() =>
			loadConfigFromEnv({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: "account-a",
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
			}),
		).toThrow("CLAWDI_WA_SIDECAR_SESSION_DIR is required");
	});

	it("loads one account-scoped physical provider session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: "account-a",
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_PORT: "9876",
			});

			expect(config.accountId).toBe("account-a");
			expect(config.port).toBe(9876);
			expect(config.sessionDir).toBe(sessionDir);
			expect(config).not.toHaveProperty("waWebSocketUrl");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
