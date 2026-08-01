import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv } from "./config.js";

describe("sidecar config", () => {
	it("requires an explicit token, account, and session directory", () => {
		expect(() => loadConfigFromEnv({})).toThrow("CLAWDI_WA_SIDECAR_TOKEN is required");
		expect(() => loadConfigFromEnv({ CLAWDI_WA_SIDECAR_TOKEN: "secret" })).toThrow(
			"CLAWDI_WA_SIDECAR_ACCOUNT_ID is required",
		);
	});

	it("loads bounded durable state and callback settings without provider overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-wa-config-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_ACCOUNT_ID: "account-1",
				CLAWDI_WA_SIDECAR_SESSION_DIR: join(root, "session"),
				CLAWDI_WA_SIDECAR_PORT: "9876",
				CLAWDI_WA_SIDECAR_CALLBACK_URL: "http://127.0.0.1/v1/callback",
				CLAWDI_WA_SIDECAR_CALLBACK_TOKEN: "callback-secret",
			});

			expect(config.port).toBe(9876);
			expect(config.accountId).toBe("account-1");
			expect(config.callback?.spoolDir).toBe(join(root, "session", "callback-spool"));
			expect(Object.hasOwn(config, "waWebSocketUrl")).toBe(false);
			expect(Object.hasOwn(config, "authCert")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects partial callback config and unsafe account ids", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-wa-config-"));
		try {
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_ACCOUNT_ID: "account-a",
					CLAWDI_WA_SIDECAR_SESSION_DIR: join(root, "partial"),
					CLAWDI_WA_SIDECAR_CALLBACK_URL: "https://callback.invalid/v1/events",
				}),
			).toThrow("must be set together");
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_ACCOUNT_ID: "../escape",
					CLAWDI_WA_SIDECAR_SESSION_DIR: root,
				}),
			).toThrow("invalid format");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
