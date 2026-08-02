import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFromEnv } from "./config.js";

describe("sidecar config", () => {
	it("requires an explicit service token and state root", () => {
		expect(() => loadConfigFromEnv({})).toThrow(
			"CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN is required",
		);
		expect(() =>
			loadConfigFromEnv({
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
			}),
		).toThrow("CLAWDI_WA_SIDECAR_STATE_ROOT is required");
	});

	it("loads one business-neutral multi-session provider service", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		try {
			const config = loadConfigFromEnv({
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_STATE_ROOT: stateRoot,
				CLAWDI_WA_SIDECAR_PORT: "9876",
			});

			expect(config.port).toBe(9876);
			expect(config.stateRoot).toBe(stateRoot);
			expect(config.webVersion).toEqual([2, 3000, 1_043_857_760]);
			expect(config.providerInbox).toEqual({
				maxEvents: 10_000,
				maxBytes: 256 * 1024 * 1024,
			});
			expect(config).not.toHaveProperty("waWebSocketUrl");
			expect(config).not.toHaveProperty("sessionId");
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("selects one service Unix socket without enabling TCP", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const stateRoot = join(root, "state");
		const socketDir = join(root, "run");
		mkdirSync(stateRoot, { mode: 0o700 });
		mkdirSync(socketDir, { mode: 0o770 });
		chmodSync(socketDir, 0o770);
		const socketPath = join(socketDir, "sidecar.sock");
		try {
			const config = loadConfigFromEnv({
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
				CLAWDI_WA_SIDECAR_STATE_ROOT: stateRoot,
				CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
			});

			expect(config.socketPath).toBe(socketPath);
			expect(() =>
				loadConfigFromEnv({
					CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_STATE_ROOT: stateRoot,
					CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
					CLAWDI_WA_SIDECAR_HOST: "0.0.0.0",
				}),
			).toThrow("cannot be combined with host or port");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed instead of repairing unsafe durable directory permissions", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		chmodSync(stateRoot, 0o755);
		try {
			expect(() =>
				loadConfigFromEnv({
					CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
					CLAWDI_WA_SIDECAR_STATE_ROOT: stateRoot,
				}),
			).toThrow("provider state root must have mode 700");
			expect((statSync(stateRoot).mode & 0o777).toString(8)).toBe("755");
		} finally {
			chmodSync(stateRoot, 0o700);
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("rejects malformed service, version, and inbox capacity settings", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-sidecar-"));
		const base = {
			CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret",
			CLAWDI_WA_SIDECAR_STATE_ROOT: stateRoot,
		};
		try {
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_STATE_ROOT: "relative/state" }),
			).toThrow("absolute normalized path");
			expect(() => loadConfigFromEnv({ ...base, CLAWDI_WA_WEB_VERSION: "2.3000.999" })).toThrow(
				"not audited",
			);
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_PROVIDER_INBOX_MAX_EVENTS: "0" }),
			).toThrow("must be an integer between 1");
			expect(() =>
				loadConfigFromEnv({ ...base, CLAWDI_WA_PROVIDER_INBOX_MAX_BYTES: "1.5" }),
			).toThrow("must be an integer between 1");
			expect(() => loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_HOST: "0.0.0.0" })).toThrow(
				"must be 127.0.0.1, localhost, or ::1",
			);
			expect(() => loadConfigFromEnv({ ...base, CLAWDI_WA_SIDECAR_PORT: "8787x" })).toThrow(
				"invalid CLAWDI_WA_SIDECAR_PORT",
			);
			expect(() =>
				loadConfigFromEnv({
					...base,
					CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "secret with spaces",
				}),
			).toThrow("printable ASCII");
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
