import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv } from "./config.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("sidecar config", () => {
	it("requires explicit token and session dir", () => {
		expect(() => loadConfigFromEnv({})).toThrow("CLAWDI_WA_PROVIDER_ACCOUNT_ID is required");
		expect(() => loadConfigFromEnv({ CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID })).toThrow(
			"CLAWDI_WA_SIDECAR_TOKEN is required",
		);
		expect(() =>
			loadConfigFromEnv({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
			}),
		).toThrow("CLAWDI_WA_SIDECAR_SESSION_DIR is required");
	});

	it("loads one account-scoped physical provider session", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_PORT: "9876",
			});

			expect(config.accountId).toBe(ACCOUNT_ID);
			expect(config.port).toBe(9876);
			expect(config.sessionDir).toBe(sessionDir);
			expect(config.webVersion).toEqual([2, 3000, 1_043_857_760]);
			expect(config.providerInbox).toEqual({
				maxEvents: 10_000,
				maxBytes: 256 * 1024 * 1024,
			});
			expect(config).not.toHaveProperty("waWebSocketUrl");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("selects an account-scoped Unix socket without enabling TCP", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const sessionDir = join(root, "state");
		const socketDir = join(root, ACCOUNT_ID);
		mkdirSync(sessionDir, { mode: 0o700 });
		mkdirSync(socketDir, { mode: 0o770 });
		chmodSync(socketDir, 0o770);
		const socketPath = join(socketDir, "sidecar.sock");
		try {
			const config = loadConfigFromEnv({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
			});

			expect(config.socketPath).toBe(socketPath);
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
					CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
					CLAWDI_WA_SIDECAR_HOST: "0.0.0.0",
				}),
			).toThrow("cannot be combined with host or port");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed instead of repairing unsafe durable directory permissions", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		chmodSync(sessionDir, 0o755);
		try {
			expect(() =>
				loadConfigFromEnv({
					CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
					CLAWDI_WA_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
				}),
			).toThrow("provider session directory must have mode 700");
			expect((statSync(sessionDir).mode & 0o777).toString(8)).toBe("755");
		} finally {
			chmodSync(sessionDir, 0o700);
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("rejects malformed account, version, and inbox capacity settings", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const base = {
			CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
			CLAWDI_WA_SIDECAR_TOKEN: "secret",
			CLAWDI_WA_SIDECAR_SESSION_DIR: sessionDir,
		};
		try {
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_SESSION_DIR: "relative/state" }),
			).toThrow("absolute normalized path");
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_PROVIDER_ACCOUNT_ID: "account-a" }),
			).toThrow("canonical UUID");
			expect(() => loadConfigFromEnv({ ...base, CLAWDI_WA_WEB_VERSION: "2.3000.999" })).toThrow(
				"not audited",
			);
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_PROVIDER_INBOX_MAX_EVENTS: "0" }),
			).toThrow("must be an integer between 1");
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_PROVIDER_INBOX_MAX_BYTES: "1.5" }),
			).toThrow("must be an integer between 1");
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_TOKEN: "secret with spaces" }),
			).toThrow("printable ASCII");
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
