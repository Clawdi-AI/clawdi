import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	daemonAutoUpdateOnce,
	detectInstallerFromPaths,
	installCommand,
	maybeAutoUpdate,
	update,
} from "../../src/commands/update";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origNoCheck: string | undefined;
let origNoAuto: string | undefined;
let origRuntimeMode: string | undefined;
let origHostPolicyPath: string | undefined;
let origArgv: string[];

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
	it("uses npm when the running clawdi binary is in npm's global bin even if bun is available", () => {
		expect(
			detectInstallerFromPaths("/home/user/.local/bin/clawdi", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				bunBin: "/home/user/.bun/bin",
			}),
		).toBe("npm");
	});

	it("uses bun when the running clawdi binary is in bun's global bin", () => {
		expect(
			detectInstallerFromPaths("/home/user/.bun/bin/clawdi", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				bunBin: "/home/user/.bun/bin",
			}),
		).toBe("bun");
	});

	it("uses npm when the resolved clawdi package path is inside npm's global root", () => {
		expect(
			detectInstallerFromPaths("/home/user/.local/lib/node_modules/clawdi/bin/clawdi.mjs", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				bunBin: "/home/user/.bun/bin",
			}),
		).toBe("npm");
	});

	it("uses bun when the resolved clawdi package path is inside Bun's global install", () => {
		expect(
			detectInstallerFromPaths(
				"/home/user/.bun/install/global/node_modules/clawdi/bin/clawdi.mjs",
				{
					npmBin: "/home/user/.local/bin",
					npmRoot: "/home/user/.local/lib/node_modules",
				},
			),
		).toBe("bun");
	});
});

describe("installCommand", () => {
	it("prints the installer-specific manual command", () => {
		expect(installCommand("npm")).toBe("npm i -g clawdi");
		expect(installCommand("bun")).toBe("bun add -g clawdi");
		expect(installCommand(null)).toBe("npm i -g clawdi");
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
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
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
				response: () => jsonResponse({ "dist-tags": { latest: current } }),
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
});

describe("daemonAutoUpdateOnce", () => {
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
				installer: "npm",
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
			});

			expect(result).toBe("installed");
			expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", "clawdi@latest"] }]);
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
				installer: "npm",
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
			});
			expect(result).toBe("installed");
			expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", "clawdi@latest"] }]);
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
				installer: "npm",
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
				installer: "npm",
				installRunner: async () => {
					throw new Error("should not install while locked");
				},
			});
			expect(result).toBe("locked");
		} finally {
			restore();
		}
	});
});

describe("maybeAutoUpdate", () => {
	it("skips local self-update path in hosted runtime mode", async () => {
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		const { captured, restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectInstaller: () => "npm",
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

	it("writes last-version on first run; no notice", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
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
			await withStdoutTty(() => maybeAutoUpdate());
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
			await withStdoutTty(() => maybeAutoUpdate());
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
			await maybeAutoUpdate();
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
			await withStdoutTty(() => maybeAutoUpdate());
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
		// Plant cache with a version way higher than package.json so this
		// remains a major-bump test regardless of the fixture version.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
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
					detectInstaller: () => "npm",
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
		expect(installs[0]?.args).toEqual(["i", "-g", "clawdi@latest"]);
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
			await maybeAutoUpdate();
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
