/**
 * Installer unit tests — assert the generated plist / systemd
 * unit content is well-formed and references the right binary.
 *
 * We intentionally do NOT exercise launchctl / systemctl here.
 * Those side effects depend on the host's user session, log
 * out / log in state, etc. — flaky in CI. The integration test
 * (running `clawdi daemon install` against a real shell) lives
 * in /tmp manual smoke tests, not in `bun test`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "clawdi-installer-test-"));
const originalHome = process.env.HOME;
const originalArgv1 = process.argv[1];

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
	const dir = mkdtempSync(join(tmp, "case-"));
	process.env.HOME = dir;
	// `install()` calls `realpathSync.native(process.argv[1])` to
	// bake an absolute path into the unit file. Tests need that
	// path to exist on disk; pinning to `/usr/local/bin/clawdi`
	// works locally for devs who installed the CLI globally but
	// blew up CI and dev machines without it. Drop a stub
	// executable in the per-case tmp dir and point argv[1] at it.
	const fakeBin = join(dir, "clawdi-bin");
	mkdirSync(dir, { recursive: true });
	writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(fakeBin, 0o755);
	process.argv[1] = fakeBin;
});

afterEach(() => {
	process.env.HOME = originalHome;
	process.argv[1] = originalArgv1 ?? "";
});

describe("installer.install (macOS plist)", () => {
	it("writes a parseable plist with the right Label and ProgramArguments", async () => {
		// Stub launchctl to a no-op so we don't actually load the
		// agent during the test. We do this via a wrapper script
		// on PATH rather than touching the real binary.
		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			// Force the platform-detect onto the macOS path. We do
			// this by importing the module fresh and stubbing
			// `os.platform` — but bun:test doesn't have a clean
			// module mock surface, so we just skip this test on
			// non-darwin hosts. The real launchd round-trip
			// covered by the manual smoke test in install proves
			// the rest.
			const os = await import("node:os");
			if (os.platform() !== "darwin") return;

			const { install } = await import("./installer");
			const result = install();
			expect(existsSync(result.unit)).toBe(true);
			const content = readFileSync(result.unit, "utf-8");
			expect(content).toContain("<key>Label</key>");
			expect(content).toContain("<string>ai.clawdi.serve</string>");
			expect(content).toContain(process.argv[1] ?? "");
			expect(content).toContain("<string>daemon</string>");
			expect(content).toContain("<string>run</string>");
			expect(content).not.toContain("<string>--agent</string>");
			expect(content).toContain("<key>RunAtLoad</key>");
			expect(content).toContain("<key>KeepAlive</key>");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("includes EnvironmentVariables with HOME so the daemon can find ~/.clawdi", async () => {
		const os = await import("node:os");
		if (os.platform() !== "darwin") return;

		// Stub launchctl as before.
		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			const { install } = await import("./installer");
			const result = install();
			const content = readFileSync(result.unit, "utf-8");
			expect(content).toContain("<key>HOME</key>");
			expect(content).toContain(process.env.HOME ?? "");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("captures CLAWDI_AUTH_TOKEN + API_URL into the plist EnvironmentVariables", async () => {
		const os = await import("node:os");
		if (os.platform() !== "darwin") return;

		// Stub launchctl as before.
		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		const oldToken = process.env.CLAWDI_AUTH_TOKEN;
		const oldApiUrl = process.env.CLAWDI_API_URL;
		process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_capture_token_value";
		process.env.CLAWDI_API_URL = "https://example.test/api";

		try {
			const { install } = await import("./installer");
			const result = install();
			const content = readFileSync(result.unit, "utf-8");
			// Both keys baked into the plist so the daemon spawned by
			// launchd after reboot still sees them. Without this, env-
			// only auth (`CLAWDI_AUTH_TOKEN=… clawdi daemon install`)
			// silently lost the token after the next login.
			expect(content).toContain("<key>CLAWDI_AUTH_TOKEN</key>");
			expect(content).toContain("clawdi_test_capture_token_value");
			expect(content).toContain("<key>CLAWDI_API_URL</key>");
			expect(content).toContain("https://example.test/api");
		} finally {
			process.env.PATH = oldPath;
			if (oldToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = oldToken;
			if (oldApiUrl === undefined) delete process.env.CLAWDI_API_URL;
			else process.env.CLAWDI_API_URL = oldApiUrl;
		}
	});

	it("does NOT capture process.env.CLAWDI_ENVIRONMENT_ID into the plist EnvironmentVariables", async () => {
		// Round 30 P2 regression: a shell-set CLAWDI_ENVIRONMENT_ID
		// must not leak into the supervisor unit. At runtime the
		// daemon's `resolveEnvironmentId` prefers env vars over the
		// per-agent file, so a captured CLAWDI_ENVIRONMENT_ID would
		// pin every installed agent to that one env id during
		// singleton daemon — every engine could be routed to the
		// same project.
		const os = await import("node:os");
		if (os.platform() !== "darwin") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;
		const oldEnv = process.env.CLAWDI_ENVIRONMENT_ID;
		process.env.CLAWDI_ENVIRONMENT_ID = "00000000-0000-0000-0000-deadbeef0001";
		try {
			const { install } = await import("./installer");
			const result = install();
			const content = readFileSync(result.unit, "utf-8");
			// CLAWDI_ENVIRONMENT_ID must NOT appear under
			// EnvironmentVariables — neither key nor value.
			expect(content).not.toContain("<key>CLAWDI_ENVIRONMENT_ID</key>");
			expect(content).not.toContain("00000000-0000-0000-0000-deadbeef0001");
			// And no `--environment-id` arg either when caller didn't
			// pass it explicitly.
			expect(content).not.toContain("<string>--environment-id</string>");
		} finally {
			process.env.PATH = oldPath;
			if (oldEnv === undefined) delete process.env.CLAWDI_ENVIRONMENT_ID;
			else process.env.CLAWDI_ENVIRONMENT_ID = oldEnv;
		}
	});

	it("writes the plist with 0o600 (owner-only) since it inlines CLAWDI_AUTH_TOKEN", async () => {
		// Round-40 P2 regression: launchd plist contains
		// `<key>CLAWDI_AUTH_TOKEN</key>` under
		// EnvironmentVariables. Pre-fix the file was 0o644 so any
		// other local user on a multi-user host could read the
		// API token. launchd reads the file as the owner, so
		// 0o600 still loads correctly.
		const os = await import("node:os");
		if (os.platform() !== "darwin") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync, statSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;
		try {
			const { install } = await import("./installer");
			const result = install();
			const mode = statSync(result.unit).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("uninstall removes a previously-installed plist", async () => {
		const os = await import("node:os");
		if (os.platform() !== "darwin") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubLaunchctl = join(stubBin, "launchctl");
		writeFileSync(stubLaunchctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubLaunchctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			const { install, uninstall } = await import("./installer");
			install();
			const result = uninstall();
			expect(result.removed).toBe(true);
			// Second uninstall is a no-op — no file, no error.
			const result2 = uninstall();
			expect(result2.removed).toBe(false);
		} finally {
			process.env.PATH = oldPath;
		}
	});
});

describe("installer.install (Linux systemd)", () => {
	it("captures RPC host and port into the unit Environment", async () => {
		const os = await import("node:os");
		if (os.platform() !== "linux") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		const { mkdirSync, chmodSync } = await import("node:fs");
		mkdirSync(stubBin, { recursive: true });
		const stubSystemctl = join(stubBin, "systemctl");
		writeFileSync(stubSystemctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		chmodSync(stubSystemctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			const { install } = await import("./installer");
			const result = install({ rpcHost: "127.0.0.1", rpcPort: 17654 });
			const content = readFileSync(result.unit, "utf-8");
			expect(content).toContain('Environment="CLAWDI_DAEMON_RPC_HOST=127.0.0.1"');
			expect(content).toContain('Environment="CLAWDI_DAEMON_RPC_PORT=17654"');
		} finally {
			process.env.PATH = oldPath;
		}
	});
});

describe("installer.readHealth", () => {
	it("returns exists=false when the file is missing", async () => {
		const { readHealth } = await import("./installer");
		const dir = mkdtempSync(join(tmp, "noh-"));
		const result = readHealth(dir);
		expect(result.exists).toBe(false);
		expect(result.ageSeconds).toBeNull();
		expect(result.version).toBeNull();
	});

	it("parses the legacy bare-ISO timestamp shape (pre-r3 daemons)", async () => {
		// Pre-r3 daemons wrote `<iso>\n`. After upgrading the CLI
		// but BEFORE the daemon's auto-restart fires, status/doctor
		// have to read the legacy file shape and not crash. Reader
		// returns version=null so drift detection skips quietly.
		const { readHealth } = await import("./installer");
		const dir = mkdtempSync(join(tmp, "legacy-"));
		writeFileSync(join(dir, "health"), `${new Date().toISOString()}\n`);
		const result = readHealth(dir);
		expect(result.exists).toBe(true);
		expect(result.ageSeconds).toBeLessThan(5);
		expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.version).toBeNull();
	});

	it("parses the new JSON shape (r3+) and exposes the version", async () => {
		const { readHealth } = await import("./installer");
		const dir = mkdtempSync(join(tmp, "json-"));
		writeFileSync(
			join(dir, "health"),
			`${JSON.stringify({ timestamp: new Date().toISOString(), version: "0.5.4" })}\n`,
		);
		const result = readHealth(dir);
		expect(result.exists).toBe(true);
		expect(result.ageSeconds).toBeLessThan(5);
		expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.version).toBe("0.5.4");
	});

	it("falls back gracefully on malformed JSON (mid-write truncation)", async () => {
		// `touchHealthFile` is non-atomic write — if the daemon
		// crashes between open() and write() (rare but possible),
		// readers shouldn't crash. Just treat the file as legacy
		// and report whatever the parser pulled out.
		const { readHealth } = await import("./installer");
		const dir = mkdtempSync(join(tmp, "broken-"));
		writeFileSync(join(dir, "health"), `{"timestamp":"2026-05-01T08:`); // truncated
		const result = readHealth(dir);
		expect(result.exists).toBe(true);
		// Falls through to legacy parsing — `timestamp` field gets
		// the raw string; version stays null. Importantly, no
		// throw.
		expect(result.version).toBeNull();
	});

	it("handles JSON with missing version field (forward-compat)", async () => {
		const { readHealth } = await import("./installer");
		const dir = mkdtempSync(join(tmp, "noversion-"));
		writeFileSync(
			join(dir, "health"),
			`${JSON.stringify({ timestamp: new Date().toISOString() })}\n`,
		);
		const result = readHealth(dir);
		expect(result.exists).toBe(true);
		expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(result.version).toBeNull();
	});
});
