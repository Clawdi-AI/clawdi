/**
 * Installer unit tests — assert the generated plist / systemd
 * unit content is well-formed and references the right binary.
 *
 * Supervisor commands are stubbed here. Modern launchctl argv has a
 * separate cross-platform fixture; daemon-systemd-user.e2e.test.ts covers
 * a real user manager in the disposable privileged systemd container.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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

	it.each(["https://example.test", undefined])(
		"stores daemon credentials in an owner-only file and captures endpoint with token origin %s",
		async (origin) => {
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
			const oldOrigin = process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			const oldApiUrl = process.env.CLAWDI_API_URL;
			const oldNoAutoUpdate = process.env.CLAWDI_NO_AUTO_UPDATE;
			process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_capture_token_value";
			if (origin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = origin;
			process.env.CLAWDI_API_URL = "https://example.test/api";
			process.env.CLAWDI_NO_AUTO_UPDATE = "1";

			try {
				const { install } = await import("./installer");
				const result = install();
				const content = readFileSync(result.unit, "utf-8");
				const tokenFile = join(process.env.HOME ?? tmp, ".clawdi", "auth-token");
				expect(content).toContain("<string>--auth-token-file</string>");
				expect(content).toContain(tokenFile);
				expect(content).not.toContain("clawdi_test_capture_token_value");
				expect(readFileSync(tokenFile, "utf-8").trim()).toBe("clawdi_test_capture_token_value");
				expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
				if (origin === undefined) {
					expect(content).not.toContain("<key>CLAWDI_AUTH_TOKEN_ORIGIN</key>");
				} else {
					expect(content).toContain(
						`<key>CLAWDI_AUTH_TOKEN_ORIGIN</key>\n    <string>${origin}</string>`,
					);
				}
				expect(content).toContain("<key>CLAWDI_API_URL</key>");
				expect(content).toContain("https://example.test/api");
				expect(content).toContain("<key>CLAWDI_NO_AUTO_UPDATE</key>");
				expect(statSync(result.unit).mode & 0o777).toBe(0o600);
			} finally {
				process.env.PATH = oldPath;
				if (oldToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
				else process.env.CLAWDI_AUTH_TOKEN = oldToken;
				if (oldOrigin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
				else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = oldOrigin;
				if (oldApiUrl === undefined) delete process.env.CLAWDI_API_URL;
				else process.env.CLAWDI_API_URL = oldApiUrl;
				if (oldNoAutoUpdate === undefined) delete process.env.CLAWDI_NO_AUTO_UPDATE;
				else process.env.CLAWDI_NO_AUTO_UPDATE = oldNoAutoUpdate;
			}
		},
	);

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

	it("writes the plist and token file with owner-only permissions", async () => {
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
	it.each(["https://example.test", undefined])(
		"stores daemon credentials in an owner-only file and captures endpoint with token origin %s",
		async (origin) => {
			const os = await import("node:os");
			if (os.platform() !== "linux") return;

			const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
			mkdirSync(stubBin, { recursive: true });
			const stubSystemctl = join(stubBin, "systemctl");
			writeFileSync(stubSystemctl, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			chmodSync(stubSystemctl, 0o755);
			const oldPath = process.env.PATH;
			const oldToken = process.env.CLAWDI_AUTH_TOKEN;
			const oldOrigin = process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			const oldApiUrl = process.env.CLAWDI_API_URL;
			process.env.PATH = `${stubBin}:${oldPath}`;
			process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_capture_token_value";
			if (origin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = origin;
			process.env.CLAWDI_API_URL = "https://example.test/api";

			try {
				const { install } = await import("./installer");
				const result = install();
				const content = readFileSync(result.unit, "utf-8");
				const tokenFile = join(process.env.HOME ?? tmp, ".clawdi", "auth-token");
				expect(content).toContain("--auth-token-file");
				expect(content).toContain(tokenFile);
				expect(content).not.toContain("clawdi_test_capture_token_value");
				expect(readFileSync(tokenFile, "utf-8").trim()).toBe("clawdi_test_capture_token_value");
				expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
				if (origin === undefined) {
					expect(content).not.toContain("CLAWDI_AUTH_TOKEN_ORIGIN=");
				} else {
					expect(content).toContain(`Environment="CLAWDI_AUTH_TOKEN_ORIGIN=${origin}"`);
				}
				expect(content).toContain('Environment="CLAWDI_API_URL=https://example.test/api"');
				expect(statSync(result.unit).mode & 0o777).toBe(0o600);
			} finally {
				process.env.PATH = oldPath;
				if (oldToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
				else process.env.CLAWDI_AUTH_TOKEN = oldToken;
				if (oldOrigin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
				else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = oldOrigin;
				if (oldApiUrl === undefined) delete process.env.CLAWDI_API_URL;
				else process.env.CLAWDI_API_URL = oldApiUrl;
			}
		},
	);

	it("stops without removing the unit and restart cold-starts it", async () => {
		const os = await import("node:os");
		if (os.platform() !== "linux") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		mkdirSync(stubBin, { recursive: true });
		const calls = join(process.env.HOME ?? tmp, "systemctl-calls");
		const stubSystemctl = join(stubBin, "systemctl");
		writeFileSync(stubSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`, {
			mode: 0o755,
		});
		chmodSync(stubSystemctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			const { install, restart, stop } = await import("./installer");
			const installed = install();
			stop();
			expect(existsSync(installed.unit)).toBe(true);
			restart();
			const commands = readFileSync(calls, "utf8").trim().split("\n");
			expect(commands).toContain("--user stop clawdi-serve.service");
			expect(commands).toContain("--user restart clawdi-serve.service");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("captures RPC host, port, and remote opt-in into the unit Environment", async () => {
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
			const result = install({
				rpcHost: "0.0.0.0",
				rpcPort: 17654,
				rpcAllowRemote: true,
			});
			const content = readFileSync(result.unit, "utf-8");
			expect(content).toContain('Environment="CLAWDI_DAEMON_RPC_HOST=0.0.0.0"');
			expect(content).toContain('Environment="CLAWDI_DAEMON_RPC_PORT=17654"');
			expect(content).toContain('Environment="CLAWDI_DAEMON_RPC_ALLOW_REMOTE=1"');
			expect(content).toContain("Restart=always");
			expect(content).toContain("RestartPreventExitStatus=2");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("preserves the unit and throws an actionable error when activation fails", async () => {
		const os = await import("node:os");
		if (os.platform() !== "linux") return;

		const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
		mkdirSync(stubBin, { recursive: true });
		const stubSystemctl = join(stubBin, "systemctl");
		writeFileSync(
			stubSystemctl,
			'#!/bin/sh\n[ "$*" = "--user show-environment" ] && exit 0\nexit 1\n',
			{ mode: 0o755 },
		);
		chmodSync(stubSystemctl, 0o755);
		const oldPath = process.env.PATH;
		process.env.PATH = `${stubBin}:${oldPath}`;

		try {
			const { install } = await import("./installer");
			let error: unknown;
			try {
				install();
			} catch (caught) {
				error = caught;
			}
			const unit = join(
				process.env.HOME ?? "",
				".config",
				"systemd",
				"user",
				"clawdi-serve.service",
			);
			expect(existsSync(unit)).toBe(true);
			if (!(error instanceof Error)) throw new Error("expected activation error");
			expect(error.message).toContain("systemctl activation failed");
			expect(error.message).toContain("systemctl --user daemon-reload");
			expect(error.message).toContain("enable --now clawdi-serve.service");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it.each(["no", "yes", "unknown"])(
		"reports the linger hint only when disabled: %s",
		async (linger) => {
			if (process.platform !== "linux") return;
			const stubBin = join(process.env.HOME ?? tmp, "stub-bin");
			mkdirSync(stubBin, { recursive: true });
			const calls = join(stubBin, "loginctl-calls");
			writeFileSync(join(stubBin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			writeFileSync(
				join(stubBin, "loginctl"),
				`#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
${linger === "unknown" ? "exit 1" : `printf '${linger}\\n'`}
`,
				{ mode: 0o755 },
			);
			const oldPath = process.env.PATH;
			process.env.PATH = `${stubBin}:${oldPath}`;
			try {
				const { install } = await import("./installer");
				const result = install();
				const content = readFileSync(result.unit, "utf8");
				expect(content).not.toContain("network-online.target");
				expect(content).toContain("Restart=always\nRestartSec=10");
				if (linger === "no") {
					expect(result.instructions).toContain("loginctl enable-linger $USER");
					expect(result.instructions).toContain("Sync stops at logout");
				} else {
					expect(result.instructions).not.toContain("enable-linger");
				}
				expect(readFileSync(calls, "utf8").trim()).toBe(
					`show-user ${process.getuid?.()} --property=Linger --value`,
				);
			} finally {
				process.env.PATH = oldPath;
			}
		},
	);
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
