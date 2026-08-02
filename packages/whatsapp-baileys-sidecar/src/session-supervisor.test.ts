import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAuditedWhatsAppWebVersion } from "./audited-version.js";
import type { SidecarSessionConfig } from "./config.js";
import { BaileysSessionSupervisor } from "./session-supervisor.js";
import type {
	BaileysRuntime,
	PairingStatus,
	RelayMessageRequest,
	RuntimeHealth,
	SidecarCapabilities,
} from "./types.js";

const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";

class FakeRuntime implements BaileysRuntime {
	starts = 0;
	stops = 0;
	stopError: Error | undefined;
	startBarrier: Promise<void> | undefined;

	constructor(readonly config: SidecarSessionConfig) {}

	async start(): Promise<void> {
		this.starts += 1;
		if (this.startBarrier) await this.startBarrier;
	}

	async stop(): Promise<void> {
		this.stops += 1;
		if (this.stopError) throw this.stopError;
	}

	health(): RuntimeHealth {
		throw new Error("not used");
	}

	capabilities(): SidecarCapabilities {
		throw new Error("not used");
	}

	pairingStatus(): PairingStatus {
		throw new Error("not used");
	}

	async startQrPairing(): Promise<PairingStatus> {
		throw new Error("not used");
	}

	async requestPairingCode(_phoneNumber: string): Promise<PairingStatus> {
		throw new Error("not used");
	}

	async cancelPairing(): Promise<PairingStatus> {
		throw new Error("not used");
	}

	async logoutPairing(): Promise<PairingStatus> {
		throw new Error("not used");
	}

	async retryPairing(): Promise<PairingStatus> {
		throw new Error("not used");
	}

	async relayMessage(_request: RelayMessageRequest): Promise<string | undefined> {
		throw new Error("not used");
	}

	async sendNode(): Promise<void> {
		throw new Error("not used");
	}

	async query(): Promise<null> {
		throw new Error("not used");
	}

	providerEvents(): [] {
		return [];
	}

	acknowledgeProviderEvents(): void {}
}

describe("business-neutral session supervisor", () => {
	it("isolates opaque sessions behind one endpoint and one state root", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-sessions-"));
		const runtimes: FakeRuntime[] = [];
		const supervisor = new BaileysSessionSupervisor(
			{
				host: "127.0.0.1",
				port: 8787,
				apiToken: "test-token",
				stateRoot,
				logLevel: "silent",
				webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
				providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
			},
			(config) => {
				const runtime = new FakeRuntime(config);
				runtimes.push(runtime);
				return runtime;
			},
		);

		try {
			const first = await supervisor.session(FIRST_SESSION);
			const sameFirst = await supervisor.session(FIRST_SESSION);
			const second = await supervisor.session(SECOND_SESSION);

			expect(first).toBe(sameFirst);
			expect(second).not.toBe(first);
			expect(runtimes).toHaveLength(2);
			expect(runtimes.map((runtime) => runtime.config.sessionId)).toEqual([
				FIRST_SESSION,
				SECOND_SESSION,
			]);
			expect(runtimes[0]?.config.sessionDir).toBe(join(stateRoot, FIRST_SESSION));
			expect(runtimes[1]?.config.sessionDir).toBe(join(stateRoot, SECOND_SESSION));
			expect(supervisor.health().activeSessions).toBe(2);
			await expect(supervisor.session("tenant-owned-shared-bot")).rejects.toThrow(
				"invalid_session_id",
			);
		} finally {
			await supervisor.stop();
			rmSync(stateRoot, { recursive: true, force: true });
		}

		expect(runtimes.every((runtime) => runtime.stops === 1)).toBe(true);
	});

	it("persists isolated SQLite state and reopens an existing session", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-persistent-sessions-"));
		const config = {
			host: "127.0.0.1",
			port: 8787,
			apiToken: "test-token",
			stateRoot,
			logLevel: "silent",
			webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
			providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
		};

		try {
			const firstSupervisor = new BaileysSessionSupervisor(config);
			await firstSupervisor.session(FIRST_SESSION);
			await firstSupervisor.session(SECOND_SESSION);
			expect(existsSync(join(stateRoot, FIRST_SESSION, "provider-state.sqlite"))).toBe(true);
			expect(existsSync(join(stateRoot, SECOND_SESSION, "provider-state.sqlite"))).toBe(true);
			await firstSupervisor.stop();

			const restartedSupervisor = new BaileysSessionSupervisor(config);
			await restartedSupervisor.session(FIRST_SESSION);
			expect(restartedSupervisor.health().activeSessions).toBe(1);
			await restartedSupervisor.stop();
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("shares one in-flight start across a burst of concurrent requests for a session", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-concurrent-start-"));
		const barrier = Promise.withResolvers<void>();
		let runtime: FakeRuntime | undefined;
		const supervisor = new BaileysSessionSupervisor(
			{
				host: "127.0.0.1",
				port: 8787,
				apiToken: "test-token",
				stateRoot,
				logLevel: "silent",
				webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
				providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
			},
			(config) => {
				runtime = new FakeRuntime(config);
				runtime.startBarrier = barrier.promise;
				return runtime;
			},
		);

		try {
			const requests = Array.from({ length: 64 }, () => supervisor.session(FIRST_SESSION));
			await Promise.resolve();
			expect(runtime?.starts).toBe(1);
			barrier.resolve();
			const runtimes = await Promise.all(requests);
			expect(runtimes.every((item) => item === runtimes[0])).toBe(true);
		} finally {
			await supervisor.stop();
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked session directory", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-symlink-session-"));
		const outside = mkdtempSync(join(tmpdir(), "clawdi-wa-symlink-target-"));
		symlinkSync(outside, join(stateRoot, FIRST_SESSION), "dir");
		const supervisor = new BaileysSessionSupervisor({
			host: "127.0.0.1",
			port: 8787,
			apiToken: "test-token",
			stateRoot,
			logLevel: "silent",
			webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
			providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
		});

		try {
			await expect(supervisor.session(FIRST_SESSION)).rejects.toThrow(
				"provider session directory must be a real directory without symlink components",
			);
			expect(supervisor.health().activeSessions).toBe(0);
		} finally {
			await supervisor.stop();
			rmSync(stateRoot, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("attempts every session stop and reports shutdown failures", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "clawdi-wa-stop-sessions-"));
		const runtimes: FakeRuntime[] = [];
		const supervisor = new BaileysSessionSupervisor(
			{
				host: "127.0.0.1",
				port: 8787,
				apiToken: "test-token",
				stateRoot,
				logLevel: "silent",
				webVersion: parseAuditedWhatsAppWebVersion("2.3000.1043857760"),
				providerInbox: { maxEvents: 100, maxBytes: 1024 * 1024 },
			},
			(config) => {
				const runtime = new FakeRuntime(config);
				runtimes.push(runtime);
				return runtime;
			},
		);

		try {
			await supervisor.session(FIRST_SESSION);
			await supervisor.session(SECOND_SESSION);
			const firstRuntime = runtimes[0];
			if (!firstRuntime) throw new Error("first runtime missing");
			firstRuntime.stopError = new Error("injected stop failure");
			await expect(supervisor.stop()).rejects.toThrow(
				"one or more provider sessions failed to stop",
			);
			expect(runtimes.map((runtime) => runtime.stops)).toEqual([1, 1]);
			expect(supervisor.health().activeSessions).toBe(0);
		} finally {
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
