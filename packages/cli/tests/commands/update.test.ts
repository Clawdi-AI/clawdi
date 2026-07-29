import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	daemonAutoUpdateOnce,
	detectInstallerFromPaths,
	installCommand,
	maybeAutoUpdate,
	update,
} from "../../src/commands/update";
import {
	createRestartCoordination,
	type RestartCoordination,
	startAutoRestart,
} from "../../src/serve/auto-restart";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origNoCheck: string | undefined;
let origNoAuto: string | undefined;
let origRuntimeMode: string | undefined;
let origHostPolicyPath: string | undefined;
let origArgv: string[];
let origExitCode: number | undefined;

const npmOwnership = {
	installer: "npm" as const,
	executable: "/owned/npm/bin/clawdi",
};

async function withStdoutTty<T>(fn: () => Promise<T>): Promise<T> {
	const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	try {
		return await fn();
	} finally {
		if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
		else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
	}
}

beforeEach(() => {
	origHome = process.env.HOME;
	origNoCheck = process.env.CLAWDI_NO_UPDATE_CHECK;
	origNoAuto = process.env.CLAWDI_NO_AUTO_UPDATE;
	origRuntimeMode = process.env.CLAWDI_RUNTIME_MODE;
	origHostPolicyPath = process.env.CLAWDI_HOST_POLICY_PATH;
	origArgv = [...process.argv];
	origExitCode = process.exitCode;
	process.exitCode = undefined;
	delete process.env.CLAWDI_NO_UPDATE_CHECK;
	delete process.env.CLAWDI_NO_AUTO_UPDATE;
	delete process.env.CLAWDI_RUNTIME_MODE;
	delete process.env.CLAWDI_HOST_POLICY_PATH;
	tmpHome = join(tmpdir(), `clawdi-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	process.env.HOME = tmpHome;
});

afterEach(() => {
	process.argv.splice(0, process.argv.length, ...origArgv);
	process.exitCode = origExitCode;
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origNoCheck) process.env.CLAWDI_NO_UPDATE_CHECK = origNoCheck;
	else delete process.env.CLAWDI_NO_UPDATE_CHECK;
	if (origNoAuto) process.env.CLAWDI_NO_AUTO_UPDATE = origNoAuto;
	else delete process.env.CLAWDI_NO_AUTO_UPDATE;
	if (origRuntimeMode) process.env.CLAWDI_RUNTIME_MODE = origRuntimeMode;
	else delete process.env.CLAWDI_RUNTIME_MODE;
	if (origHostPolicyPath) process.env.CLAWDI_HOST_POLICY_PATH = origHostPolicyPath;
	else delete process.env.CLAWDI_HOST_POLICY_PATH;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("detectInstaller", () => {
	it("uses npm when the resolved entry is inside npm's global package root", () => {
		expect(
			detectInstallerFromPaths("/home/user/.local/lib/node_modules/clawdi/bin/clawdi.mjs", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				bunBin: "/home/user/.bun/bin",
				bunRoot: "/home/user/.bun/install/global/node_modules",
			}),
		).toBe("npm");
	});

	it("uses bun when the resolved entry is inside Bun's global package root", () => {
		expect(
			detectInstallerFromPaths(
				"/home/user/.bun/install/global/node_modules/clawdi/bin/clawdi.mjs",
				{
					npmBin: "/home/user/.local/bin",
					npmRoot: "/home/user/.local/lib/node_modules",
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/home/user/.bun/install/global/node_modules",
				},
			),
		).toBe("bun");
	});

	it("does not infer ownership from an executable merely being in a global bin", () => {
		expect(
			detectInstallerFromPaths("/home/user/.local/bin/clawdi", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				bunBin: "/home/user/.bun/bin",
				bunRoot: "/home/user/.bun/install/global/node_modules",
			}),
		).toBeNull();
	});

	it("rejects Bun 1.3.14 bunx and npm npx cache ownership", () => {
		expect(
			detectInstallerFromPaths("/tmp/bunx-1000-clawdi@latest/node_modules/clawdi/bin/clawdi.mjs", {
				bunBin: "/home/user/.bun/bin",
				bunRoot: "/tmp/bunx-1000-clawdi@latest/node_modules",
			}),
		).toBeNull();
		expect(
			detectInstallerFromPaths(
				"C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\clawdi\\bin\\clawdi.mjs",
				{
					npmBin: "C:\\Users\\test\\AppData\\Roaming\\npm",
					npmRoot: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules",
				},
			),
		).toBeNull();
	});
});

describe("installCommand", () => {
	it("prints the installer-specific exact command", () => {
		expect(installCommand("npm", "1.2.3")).toBe("npm i -g clawdi@1.2.3");
		expect(installCommand("bun", "1.2.3-beta.10")).toBe("bun add -g clawdi@1.2.3-beta.10");
		expect(installCommand(null, "1.2.3")).toBe("npm i -g clawdi@1.2.3");
	});
});

describe("update --json", () => {
	it("reports upgrade available when registry has a newer version", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0", beta: "99.0.0" } }),
			},
		]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as {
			current: string;
			latest: string;
			upgradeAvailable: boolean;
		};
		expect(result.latest).toBe("99.0.0");
		expect(result.upgradeAvailable).toBe(true);
	});

	it("reports up-to-date when registry latest equals current", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		// Read the current version from package.json via fetch indirection — the registry returns it.
		// getCliVersion() reads from disk; we match it by echoing the same value.
		const { getCliVersion } = await import("../../src/lib/version");
		const current = getCliVersion();

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: current, beta: current } }),
			},
		]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as { upgradeAvailable: boolean };
		expect(result.upgradeAvailable).toBe(false);
	});

	it("reports latest=null when registry is unreachable", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		// No handler installed → mockFetch 404s the registry call
		const { restore } = mockFetch([]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as { latest: string | null; upgradeAvailable: boolean };
		expect(result.latest).toBeNull();
		expect(result.upgradeAvailable).toBe(false);
	});

	it("rejects a registry dist-tag value that is not an exact semver", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "latest" } }),
			},
		]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}
		expect((JSON.parse(captured) as { latest: string | null }).latest).toBeNull();
	});
});

describe("update install", () => {
	it("uses safe Windows command vectors for exact npm install and owned executable smoke", async () => {
		const installs: { command: string; args: string[] }[] = [];
		const smokes: { command: string; args: string[] }[] = [];
		const ownership = {
			installer: "npm" as const,
			executable: "C:\\Program Files\\npm\\clawdi.cmd",
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
			},
		]);
		try {
			await withStdoutTty(() =>
				update(
					{},
					{
						detectOwnership: () => ownership,
						installRunner: (command, args) => {
							installs.push({ command, args });
							return 0;
						},
						platform: "win32",
						versionReader: (command, args) => {
							smokes.push({ command, args });
							return "99.0.0";
						},
					},
				),
			);
		} finally {
			restore();
		}

		expect(installs).toEqual([
			{
				command: "cmd.exe",
				args: ["/d", "/s", "/c", "npm.cmd", "i", "-g", "clawdi@99.0.0"],
			},
		]);
		expect(smokes).toEqual([
			{
				command: "cmd.exe",
				args: ["/d", "/s", "/c", ownership.executable, "--version"],
			},
		]);
		expect(process.exitCode).toBeUndefined();
	});

	it("does not claim success when the owned executable reports another version", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
			},
		]);
		try {
			await withStdoutTty(() =>
				update(
					{},
					{
						detectOwnership: () => npmOwnership,
						installRunner: () => 0,
						versionReader: () => "98.0.0",
					},
				),
			);
		} finally {
			restore();
		}

		expect(process.exitCode).toBe(1);
		expect(() => readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8")).toThrow();
	});

	it("reports an exact manual command without installing when ownership is unknown", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
			},
		]);
		try {
			await withStdoutTty(() =>
				update(
					{},
					{
						detectOwnership: () => null,
						installRunner: () => {
							throw new Error("unowned invocation must not install");
						},
					},
				),
			);
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toContain("Automatic update is unsupported");
		expect(captured).toContain("npm i -g clawdi@99.0.0");
	});
});

describe("daemonAutoUpdateOnce", () => {
	it("cannot bypass hosted update authority with ignoreDisabled", async () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const { captured, restore } = mockFetch([]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ignoreDisabled: true,
				installRunner: async () => {
					throw new Error("hosted policy must prevent local CLI installation");
				},
			});
			expect(result).toBe("disabled");
			expect(captured).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("installs updates and leaves last-version for the next human CLI notice", async () => {
		const calls: { installer: string; args: string[] }[] = [];
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "1.2.4" } }),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: npmOwnership,
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
				versionReader: (executable) => (executable === npmOwnership.executable ? "1.2.4" : null),
			});

			expect(result).toBe("installed");
			expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", "clawdi@1.2.4"] }]);
			expect(readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8").trim()).toBe("1.2.3");
		} finally {
			restore();
		}
	});

	it("auto-installs major updates from daemon context", async () => {
		const calls: { installer: string; args: string[] }[] = [];
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "2.0.0" } }),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.9.9",
				ownership: npmOwnership,
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
				versionReader: () => "2.0.0",
			});
			expect(result).toBe("installed");
			expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", "clawdi@2.0.0"] }]);
		} finally {
			restore();
		}
	});

	it.each([
		["rc", "0.12.10-rc.2", "0.12.10-rc.10"],
		["alpha", "0.12.11-alpha.1", "0.12.11-alpha.2"],
	])("routes %s prereleases through the beta dist-tag", async (tag, current, next) => {
		const calls: { installer: string; args: string[] }[] = [];
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () =>
					jsonResponse({
						"dist-tags": {
							latest: "0.12.9",
							beta: next,
							[tag]: `99.0.0-${tag}.1`,
						},
					}),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: current,
				ownership: npmOwnership,
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
				versionReader: () => next,
			});
			expect(result).toBe("installed");
			expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", `clawdi@${next}`] }]);
		} finally {
			restore();
		}
	});

	it("respects autoUpdate=false for daemon auto-update", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "config.json"), JSON.stringify({ autoUpdate: "false" }));
		const { captured: fetches, restore } = mockFetch([]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: npmOwnership,
			});
			expect(result).toBe("disabled");
			expect(fetches).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("uses a cross-daemon lock so only one daemon installs at a time", async () => {
		mkdirSync(join(tmpHome, ".clawdi", "daemon-auto-update.lock"), { recursive: true });
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "1.2.4" } }),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: npmOwnership,
				installRunner: async () => {
					throw new Error("should not install while locked");
				},
			});
			expect(result).toBe("locked");
		} finally {
			restore();
		}
	});

	it("fails validation when the owned executable is not the resolved version", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "1.2.4" } }),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: npmOwnership,
				installRunner: async () => 0,
				versionReader: () => "1.2.5",
			});

			expect(result).toBe("failed");
			expect(() => readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8")).toThrow();
		} finally {
			restore();
		}
	});

	it("returns unsupported without installing from an unowned invocation", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "1.2.4" } }),
			},
		]);
		try {
			const result = await daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: null,
				installRunner: async () => {
					throw new Error("unsupported invocation must not install");
				},
			});
			expect(result).toBe("unsupported");
		} finally {
			restore();
		}
	});

	it("defers an mtime restart until a slow install closes and validates", async () => {
		const entry = join(tmpHome, "owned-entry.js");
		writeFileSync(entry, "old\n");
		const abort = new AbortController();
		const baseRestart = createRestartCoordination(abort);
		let observeWatcherRequest: (() => void) | undefined;
		const watcherRequested = new Promise<void>((resolve) => {
			observeWatcherRequest = resolve;
		});
		const restart: RestartCoordination = {
			duringUpdateInstall: (work) => baseRestart.duringUpdateInstall(work),
			requestRestart: () => {
				observeWatcherRequest?.();
				return baseRestart.requestRestart();
			},
		};
		await startAutoRestart({ abort, restart, entryPath: entry, pollMs: 5 });

		let finishInstall: (() => void) | undefined;
		const installGate = new Promise<void>((resolve) => {
			finishInstall = resolve;
		});
		const lifecycle: string[] = [];
		abort.signal.addEventListener("abort", () => lifecycle.push("restart"), { once: true });
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "1.2.4" } }),
			},
		]);
		try {
			const updatePromise = daemonAutoUpdateOnce({
				currentVersion: "1.2.3",
				ownership: npmOwnership,
				restartCoordination: restart,
				installRunner: async () => {
					lifecycle.push("install-start");
					const changed = new Date(Date.now() + 10_000);
					utimesSync(entry, changed, changed);
					await installGate;
					lifecycle.push("installer-close");
					return 0;
				},
				versionReader: () => {
					lifecycle.push("validated");
					return "1.2.4";
				},
			});

			await watcherRequested;
			expect(abort.signal.aborted).toBe(false);
			finishInstall?.();
			expect(await updatePromise).toBe("installed");
			expect(abort.signal.aborted).toBe(false);
			restart.requestRestart();
			expect(abort.signal.aborted).toBe(true);
			expect(lifecycle).toEqual(["install-start", "installer-close", "validated", "restart"]);
		} finally {
			finishInstall?.();
			abort.abort();
			restore();
		}
	});

	it("restarts immediately for an entry change outside an update install", async () => {
		const entry = join(tmpHome, "external-entry.js");
		writeFileSync(entry, "old\n");
		const abort = new AbortController();
		const restart = createRestartCoordination(abort);
		await startAutoRestart({ abort, restart, entryPath: entry, pollMs: 5 });
		const restarted = new Promise<void>((resolve) => {
			abort.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		const changed = new Date(Date.now() + 10_000);
		utimesSync(entry, changed, changed);
		await restarted;
		expect(abort.signal.aborted).toBe(true);
	});
});

describe("maybeAutoUpdate", () => {
	it("skips local self-update path in hosted runtime mode", async () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const { captured, restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => npmOwnership,
					spawnBackgroundInstall: () => {
						throw new Error("should not spawn hosted local self-update");
					},
				}),
			);
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
	});

	it("leaves TTY stdout untouched for every --json invocation", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		process.argv.splice(2, process.argv.length - 2, "status", "--json");
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => {
						throw new Error("--json must skip updater ownership detection");
					},
					spawnBackgroundInstall: () => {
						throw new Error("--json must not install");
					},
				}),
			);
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toBe("");
		expect(fetches).toHaveLength(0);
		expect(readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8").trim()).toBe("0.0.1");
	});

	it("silently skips background update for an unowned invocation", async () => {
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => null,
					spawnBackgroundInstall: () => {
						throw new Error("unowned invocation must not install");
					},
				}),
			);
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toBe("");
		expect(fetches).toHaveLength(0);
	});

	it("writes last-version on first run; no notice", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate({
				detectOwnership: () => {
					throw new Error("startup without a newer version must not probe global ownership");
				},
			});
		} finally {
			console.log = orig;
			restore();
		}
		const lastFile = join(tmpHome, ".clawdi", "last-version");
		expect(readFileSync(lastFile, "utf-8").trim().length).toBeGreaterThan(0);
		// First run — no prior `last-version` to compare against.
		expect(captured).not.toContain("Updated clawdi to");
	});

	it("prints `Updated clawdi to vX` when last-version differs from current", async () => {
		// Plant an OLDER last-version so the current binary version looks fresh.
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => {
						throw new Error("update notices must not probe global ownership");
					},
				}),
			);
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toContain("Updated clawdi to");
		expect(captured).toContain("(was v0.0.1)");
	});

	it("nudges daemon restart after CLI update when an installed daemon reports an older version", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		writeInstalledDaemon("codex");
		writeDaemonHealth("codex", "0.0.1");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await withStdoutTty(() => maybeAutoUpdate({ detectOwnership: () => npmOwnership }));
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toContain("Updated clawdi to");
		expect(captured).toContain("Restart the daemon to pick it up: clawdi daemon restart");
	});

	it("keeps post-update notice out of non-TTY stdout", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate({ detectOwnership: () => npmOwnership });
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).not.toContain("Updated clawdi to");
		expect(readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8").trim()).not.toBe(
			"0.0.1",
		);
	});

	it("respects CLAWDI_NO_AUTO_UPDATE — no spawn, human notice still allowed", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		process.env.CLAWDI_NO_AUTO_UPDATE = "1";
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await withStdoutTty(() => maybeAutoUpdate({ detectOwnership: () => npmOwnership }));
		} finally {
			console.log = orig;
			delete process.env.CLAWDI_NO_AUTO_UPDATE;
			restore();
		}
		// `Updated clawdi to` notice still fires (it's a post-fact notification,
		// not an update action — opting out shouldn't hide the truth that the
		// binary is now newer than last seen).
		expect(captured).toContain("Updated clawdi to");
		// But no registry fetch / install spawn should be triggered.
		expect(fetches).toHaveLength(0);
	});

	it("auto-installs major updates from human CLI startup", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		const { getCliVersion } = await import("../../src/lib/version");
		const current = getCliVersion();
		const channel = current.includes("-")
			? (current.split("-", 2)[1]?.split(".", 1)[0] ?? "latest")
			: "latest";
		const cacheFile = channel === "latest" ? "update.json" : `update-${channel}.json`;
		// Plant cache with a version way higher than package.json so this
		// remains a major-bump test regardless of the fixture version.
		writeFileSync(
			join(tmpHome, ".clawdi", cacheFile),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		const installs: {
			installer: string;
			args: string[];
			latest: string;
			logFd: number;
		}[] = [];
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => npmOwnership,
					spawnBackgroundInstall: (installer, args, context) => {
						installs.push({ installer, args, latest: context.latest, logFd: context.logFd });
					},
				}),
			);
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toContain("Updating clawdi v");
		expect(captured).toContain("→ v999.0.0 in background");
		expect(captured).not.toContain("Major release");
		expect(installs).toHaveLength(1);
		expect(installs[0]?.installer).toBe("npm");
		expect(installs[0]?.args).toEqual(["i", "-g", "clawdi@999.0.0"]);
		expect(installs[0]?.latest).toBe("999.0.0");
		expect(installs[0]?.logFd ?? -1).toBeGreaterThanOrEqual(0);
	});

	it("respects autoUpdate=false config — skips install path", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "config.json"), JSON.stringify({ autoUpdate: "false" }));
		// Cache says a newer version is available.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate({ detectOwnership: () => npmOwnership });
		} finally {
			console.log = orig;
			restore();
		}
		// No "Updating in background…" line — the install path is skipped.
		expect(captured).not.toContain("in background");
	});

	it("skips long-lived daemon invocations so daemons do not consume update notices", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		process.argv.splice(2, process.argv.length - 2, "daemon", "run", "--agent", "codex");
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await withStdoutTty(() => maybeAutoUpdate());
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).not.toContain("Updated clawdi to");
		expect(fetches).toHaveLength(0);
		expect(readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8").trim()).toBe("0.0.1");
	});

	it("skips update/config/help startup invocations", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		const cases = [["update", "--check"], ["config", "set", "autoUpdate", "false"], ["--version"]];

		for (const argv of cases) {
			process.argv.splice(2, process.argv.length - 2, ...argv);
			const { captured: fetches, restore } = mockFetch([]);
			try {
				await withStdoutTty(() => maybeAutoUpdate());
			} finally {
				restore();
			}
			expect(fetches).toHaveLength(0);
			expect(readFileSync(join(tmpHome, ".clawdi", "last-version"), "utf-8").trim()).toBe("0.0.1");
		}
	});
});

function writeInstalledDaemon(agent: string): void {
	const path =
		process.platform === "darwin"
			? join(tmpHome, "Library", "LaunchAgents", `ai.clawdi.serve.${agent}.plist`)
			: join(tmpHome, ".config", "systemd", "user", `clawdi-serve-${agent}.service`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "test daemon unit\n");
}

function writeDaemonHealth(agent: string, version: string): void {
	const dir = join(tmpHome, ".clawdi", "serve", agent);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "health"),
		`${JSON.stringify({ timestamp: new Date().toISOString(), version })}\n`,
	);
}
