import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	AUTO_UPDATE_MIN_AGE_MS,
	daemonAutoUpdateOnce,
	detectCurrentUpdateOwnership,
	detectPackageManagerUpdateOwnershipFromPaths,
	installCommand,
	maybeAutoUpdate,
	nativeInstallCommand,
	runBackgroundUpdateWorker,
	runInstallerProcess,
	update,
} from "../../src/commands/update";
import {
	NATIVE_TARGETS,
	type NativeTarget,
	nativeAssetName,
} from "../../src/lib/native-release-manifest";
import { getCliVersion } from "../../src/lib/version";
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
	kind: "package" as const,
	installer: "npm" as const,
	installerExecutable: "/owned/npm/bin/npm",
	executable: "/owned/npm/bin/clawdi",
};

async function withStdoutTty<T>(fn: () => Promise<T>, tty = true): Promise<T> {
	const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	try {
		return await fn();
	} finally {
		if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
		else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
	}
}

async function captureOutput(fn: () => Promise<void>) {
	const originalLog = console.log;
	const originalError = console.error;
	let stdout = "";
	let stderr = "";
	console.log = (...args: unknown[]) => {
		stdout += `${args.map(String).join(" ")}\n`;
	};
	console.error = (...args: unknown[]) => {
		stderr += `${args.map(String).join(" ")}\n`;
	};
	try {
		await fn();
		return { stdout, stderr };
	} finally {
		console.log = originalLog;
		console.error = originalError;
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
	process.exitCode = 0;
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
	// Bun latches a non-zero exit code when it is reset to `undefined`.
	process.exitCode = origExitCode ?? 0;
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

describe("package manager update ownership", () => {
	it("uses npm when the resolved entry is inside npm's global package root", () => {
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"/home/user/.local/lib/node_modules/clawdi/bin/clawdi.mjs",
				{
					npmBin: "/home/user/.local/bin",
					npmRoot: "/home/user/.local/lib/node_modules",
					npmExecutable: "/home/user/.local/bin/npm",
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/home/user/.bun/install/global/node_modules",
					bunExecutable: "/home/user/.bun/bin/bun",
				},
			),
		).toEqual({
			kind: "package",
			installer: "npm",
			installerExecutable: "/home/user/.local/bin/npm",
			executable: "/home/user/.local/bin/clawdi",
		});
	});

	it("uses bun when the resolved entry is inside Bun's global package root", () => {
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"/home/user/.bun/install/global/node_modules/clawdi/bin/clawdi.mjs",
				{
					npmBin: "/home/user/.local/bin",
					npmRoot: "/home/user/.local/lib/node_modules",
					npmExecutable: "/home/user/.local/bin/npm",
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/home/user/.bun/install/global/node_modules",
					bunExecutable: "/home/user/.bun/bin/bun",
				},
			),
		).toEqual({
			kind: "package",
			installer: "bun",
			installerExecutable: "/home/user/.bun/bin/bun",
			executable: "/home/user/.bun/bin/clawdi",
		});
	});

	it("binds a Bun-owned install to its positively identified absolute Bun executable", () => {
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"/home/user/.bun/install/global/node_modules/clawdi/bin/clawdi.mjs",
				{
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/home/user/.bun/install/global/node_modules",
					bunExecutable: "/home/user/.bun/bin/bun",
				},
			),
		).toEqual({
			kind: "package",
			installer: "bun",
			installerExecutable: "/home/user/.bun/bin/bun",
			executable: "/home/user/.bun/bin/clawdi",
		});
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"/home/user/.bun/install/global/node_modules/clawdi/bin/clawdi.mjs",
				{
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/home/user/.bun/install/global/node_modules",
					bunExecutable: "bun",
				},
			),
		).toBeNull();
	});

	it("finds the owning absolute Bun executable outside the supervisor PATH", () => {
		if (process.platform === "win32") return;
		const bunExecutable = join(tmpHome, ".bun", "bin", "bun");
		const invokedPath = join(
			tmpHome,
			".bun",
			"install",
			"global",
			"node_modules",
			"clawdi",
			"bin",
			"clawdi.mjs",
		);
		mkdirSync(dirname(bunExecutable), { recursive: true });
		mkdirSync(dirname(invokedPath), { recursive: true });
		writeFileSync(
			bunExecutable,
			[
				"#!/bin/sh",
				'if [ "$1" = pm ] && [ "$2" = bin ] && [ "$3" = -g ]; then',
				`  printf "%s\\n" ${JSON.stringify(join(tmpHome, ".bun", "bin"))}`,
				"  exit 0",
				"fi",
				"exit 1",
			].join("\n"),
		);
		chmodSync(bunExecutable, 0o700);
		writeFileSync(invokedPath, "// fixture\n");
		const previousPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/bin";
		process.argv[1] = invokedPath;
		try {
			expect(detectCurrentUpdateOwnership()).toEqual({
				kind: "package",
				installer: "bun",
				installerExecutable: bunExecutable,
				executable: join(tmpHome, ".bun", "bin", "clawdi"),
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("does not infer ownership from an executable merely being in a global bin", () => {
		expect(
			detectPackageManagerUpdateOwnershipFromPaths("/home/user/.local/bin/clawdi", {
				npmBin: "/home/user/.local/bin",
				npmRoot: "/home/user/.local/lib/node_modules",
				npmExecutable: "/home/user/.local/bin/npm",
				bunBin: "/home/user/.bun/bin",
				bunRoot: "/home/user/.bun/install/global/node_modules",
				bunExecutable: "/home/user/.bun/bin/bun",
			}),
		).toBeNull();
	});

	it("rejects Bun 1.3.14 bunx and npm npx cache ownership", () => {
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"/tmp/bunx-1000-clawdi@latest/node_modules/clawdi/bin/clawdi.mjs",
				{
					bunBin: "/home/user/.bun/bin",
					bunRoot: "/tmp/bunx-1000-clawdi@latest/node_modules",
					bunExecutable: "/home/user/.bun/bin/bun",
				},
			),
		).toBeNull();
		expect(
			detectPackageManagerUpdateOwnershipFromPaths(
				"C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\clawdi\\bin\\clawdi.mjs",
				{
					npmBin: "C:\\Users\\test\\AppData\\Roaming\\npm",
					npmRoot: "C:\\Users\\test\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules",
					npmExecutable: "C:\\Users\\test\\AppData\\Roaming\\npm\\npm.cmd",
				},
			),
		).toBeNull();
	});
});

describe("Windows native install guidance", () => {
	it("prints the PowerShell installer with a validated exact version", () => {
		expect(nativeInstallCommand(undefined, "win32")).toBe(
			"irm https://clawdi.ai/install.ps1 | iex",
		);
		expect(nativeInstallCommand("1.2.3-beta.1+build.2", "win32")).toBe(
			"$env:CLAWDI_VERSION='1.2.3-beta.1+build.2'; irm https://clawdi.ai/install.ps1 | iex",
		);
		expect(() => nativeInstallCommand("1.2.3'; exit", "win32")).toThrow(
			"invalid clawdi update version",
		);
	});
});

describe("installCommand", () => {
	it("prints the installer-specific exact command", () => {
		expect(installCommand("npm", "1.2.3")).toBe("npm i -g clawdi@1.2.3");
		expect(installCommand("bun", "1.2.3-beta.10")).toBe("bun add -g clawdi@1.2.3-beta.10");
		expect(installCommand(null, "1.2.3")).toBe("npm i -g clawdi@1.2.3");
	});
});

describe("installer process lifetime", () => {
	it.each(["timeout", "abort"] as const)(
		"terminates the entire installer process group after %s",
		async (trigger) => {
			if (process.platform === "win32") return;
			const script = join(tmpHome, `installer-tree-${trigger}.sh`);
			const descendantPidPath = join(tmpHome, `installer-descendant-${trigger}.pid`);
			writeFileSync(
				script,
				[
					"trap '' TERM",
					'sh -c \'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done\' child "$1" &',
					"wait",
				].join("\n"),
			);
			const abort = new AbortController();
			const running = runInstallerProcess("/bin/sh", [script, descendantPidPath], {
				signal: abort.signal,
				timeoutMs: trigger === "timeout" ? 200 : 5_000,
				termGraceMs: 20,
			});
			await waitForPath(descendantPidPath);
			if (trigger === "abort") abort.abort();
			expect(await running).toBeNull();
			const descendantPid = Number(readFileSync(descendantPidPath, "utf8").trim());
			expect(Number.isInteger(descendantPid)).toBe(true);
			await waitForProcessExit(descendantPid);
			expect(processIsAlive(descendantPid)).toBe(false);
		},
	);
});

describe("update --json", () => {
	it("reports Desktop ownership without consulting the standalone CLI feed", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};
		try {
			await update({ json: true }, { isDesktopManaged: () => true });
		} finally {
			console.log = orig;
		}

		expect(JSON.parse(captured)).toMatchObject({
			latest: null,
			upgradeAvailable: false,
			managedBy: "desktop",
		});
	});

	it("reports Homebrew ownership without invoking the standalone updater", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};
		try {
			await update(
				{ json: true },
				{ isDesktopManaged: () => false, isHomebrewManaged: () => true },
			);
		} finally {
			console.log = orig;
		}

		expect(JSON.parse(captured)).toMatchObject({
			latest: null,
			upgradeAvailable: false,
			managedBy: "homebrew",
		});
	});

	it("reports upgrade available when registry has a newer version", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "99.0.0" }),
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
		const current = getCliVersion();

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: current }),
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

	it.each(["http", "network"] as const)(
		"reports a registry %s failure as an error with exit 1",
		async (failure) => {
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () => {
						if (failure === "network") throw new TypeError("fetch failed");
						return new Response("unavailable", { status: 503 });
					},
				},
			]);
			try {
				const { stdout, stderr } = await captureOutput(() =>
					withStdoutTty(() => update({}), false),
				);
				const result = JSON.parse(stdout);
				expect(result).toMatchObject({
					latest: null,
					error: {
						code: "registry_unreachable",
						message: "Could not reach https://registry.npmjs.org/-/package/clawdi/dist-tags",
					},
				});
				expect(result).not.toHaveProperty("upgradeAvailable");
				expect(stderr).toContain(result.error.message);
				expect(process.exitCode).toBe(1);
			} finally {
				restore();
			}
		},
	);

	it("fails a TTY check when the registry is unreachable", async () => {
		const { restore } = mockFetch([]);
		try {
			const { stdout, stderr } = await captureOutput(() =>
				withStdoutTty(() => update({ check: true })),
			);
			expect(stdout).toBe("");
			expect(stderr).toContain(
				"Could not reach https://registry.npmjs.org/-/package/clawdi/dist-tags",
			);
			expect(process.exitCode).toBe(1);
		} finally {
			restore();
		}
	});

	it.each([{}, { yes: true, check: true }])(
		"keeps non-TTY runs check-only without install authorization: %j",
		async (opts) => {
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () => jsonResponse(releaseTags("99.0.0")),
				},
			]);
			let installed = false;
			try {
				const { stdout, stderr } = await captureOutput(() =>
					withStdoutTty(
						() =>
							update(opts, {
								detectOwnership: () => npmOwnership,
								installRunner: () => {
									installed = true;
									return 0;
								},
							}),
						false,
					),
				);
				expect(JSON.parse(stdout)).toMatchObject({
					latest: "99.0.0",
					upgradeAvailable: true,
					installed: false,
				});
				expect(stderr).toContain("clawdi v99.0.0 is available. Re-run with --yes to install.");
				expect(installed).toBe(false);
				expect(process.exitCode).toBe(0);
			} finally {
				restore();
			}
		},
	);

	it("rejects a registry dist-tag value that is not an exact semver", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "latest" }),
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
	it.each(["npm", "bun"] as const)(
		"installs via the owning %s with --yes in non-TTY",
		async (installer) => {
			const calls: { command: string; args: string[] }[] = [];
			const ownership = { ...npmOwnership, installer };
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () => jsonResponse(releaseTags("99.0.0")),
				},
			]);
			try {
				const { stdout, stderr } = await captureOutput(() =>
					withStdoutTty(
						() =>
							update(
								{ yes: true },
								{
									detectOwnership: () => ownership,
									installRunner: (command, args) => {
										calls.push({ command, args });
										return 0;
									},
									versionReader: () => (calls.length === 1 ? "99.0.0" : null),
								},
							),
						false,
					),
				);
				expect(calls).toEqual([
					{
						command: ownership.installerExecutable,
						args: [installer === "npm" ? "i" : "add", "-g", "clawdi@99.0.0"],
					},
				]);
				expect(JSON.parse(stdout)).toMatchObject({
					latest: "99.0.0",
					upgradeAvailable: true,
					installed: true,
				});
				expect(stderr).toContain("clawdi v99.0.0 installed.");
				expect(process.exitCode).toBe(0);
			} finally {
				restore();
			}
		},
	);

	it("keeps installer progress out of JSON stdout with --yes --json", () => {
		if (process.platform === "win32") return;
		const installerPath = join(tmpHome, "fake-npm");
		const executable = join(tmpHome, "fake-clawdi");
		writeFileSync(
			installerPath,
			'#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\nprintf "Installing fake release\\n"\n',
			{ mode: 0o700 },
		);
		writeFileSync(executable, '#!/bin/sh\nprintf "99.0.0\\n"\n', { mode: 0o700 });
		const script = join(tmpHome, "update-json.ts");
		const modulePath = new URL("../../src/commands/update.ts", import.meta.url).pathname;
		writeFileSync(
			script,
			[
				`import { update } from ${JSON.stringify(modulePath)};`,
				'globalThis.fetch = async () => new Response(JSON.stringify({ latest: "99.0.0" }));',
				`await update({ yes: true, json: true }, { isDesktopManaged: () => false, isHomebrewManaged: () => false, detectOwnership: () => (${JSON.stringify({ ...npmOwnership, installerExecutable: installerPath, executable })}) });`,
			].join("\n"),
		);
		const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ latest: "99.0.0", installed: true });
		expect(result.stderr).toContain("Installing fake release");
		expect(readFileSync(`${installerPath}.args`, "utf8").trim().split("\n")).toEqual([
			"i",
			"-g",
			"clawdi@99.0.0",
		]);
	});

	it("reports an unreachable native manifest with exit 1 in non-TTY", async () => {
		const captured = await runNativeForegroundFailure(
			testFetcher(async () => {
				throw new TypeError("fetch failed");
			}),
			undefined,
			true,
		);
		expect(JSON.parse(captured.stdout)).toMatchObject({ latest: "99.0.0", installed: false });
		expect(captured.stderr).toContain(
			"Could not reach the native release manifest. Check your network and retry.",
		);
		expect(process.exitCode).toBe(1);
	});

	it.each([
		{
			name: "manifest 404",
			expected: "Native release manifest download failed (404).",
			fetcher: testFetcher(async () => new Response("missing", { status: 404 })),
		},
		{
			name: "checksum mismatch",
			expected: "Native release checksum verification failed.",
			fetcher: testFetcher(async (input) =>
				String(input).endsWith("clawdi-cli-manifest-v2.txt")
					? new Response(nativeManifest("99.0.0", "0".repeat(64)))
					: new Response("not the approved archive"),
			),
		},
		{
			name: "cancellation",
			expected: "Native update was canceled.",
			fetcher: testFetcher(async () => {
				throw new DOMException("cancelled", "AbortError");
			}),
		},
	])("reports a sanitized native $name", async ({ expected, fetcher }) => {
		const { stderr } = await runNativeForegroundFailure(fetcher);
		expect(stderr).toContain(`${expected} Try manually:`);
		expect(stderr).toContain("CLAWDI_VERSION=99.0.0 sh");
	});

	it("reports a native download deadline without exposing an internal path", async () => {
		const fetcher = testFetcher(
			async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
				}),
		);
		const { stderr } = await runNativeForegroundFailure(fetcher, 5);
		expect(stderr).toContain("Native release download timed out. Try manually:");
		expect(stderr).not.toContain(tmpHome);
	});

	it.each([false, true])(
		"downloads an exact native archive and executes its staged activation child (yes=%s)",
		async (yes) => {
			const prefix = join(tmpHome, "native-prefix");
			const payload = join(tmpHome, "native-payload");
			const archivePath = join(tmpHome, "native.tar.gz");
			const probeLog = join(tmpHome, "native-probe.log");
			mkdirSync(join(payload, "egress-addon"), { recursive: true });
			mkdirSync(join(payload, "skills", "clawdi"), { recursive: true });
			mkdirSync(join(payload, "skills", "hosted-versions", "1", "clawdi"), {
				recursive: true,
			});
			writeFileSync(
				join(payload, "clawdi"),
				'#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$CLAWDI_NATIVE_PROBE_LOG"\nexit 0\n',
				{ mode: 0o755 },
			);
			writeFileSync(join(payload, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
			writeFileSync(join(payload, "skills", "clawdi", "SKILL.md"), "# skill\n");
			writeFileSync(
				join(payload, "skills", "hosted-versions", "1", "clawdi", "SKILL.md"),
				"# hosted\n",
			);
			const tarResult = spawnSync("tar", [
				"-czf",
				archivePath,
				"-C",
				payload,
				"clawdi",
				"egress-addon",
				"skills",
			]);
			expect(tarResult.status).toBe(0);
			const archive = readFileSync(archivePath);
			const checksum = createHash("sha256").update(archive).digest("hex");
			const manifest = nativeManifest("99.0.0", checksum);
			const nativeFetcher = testFetcher(async (input) =>
				String(input).endsWith("clawdi-cli-manifest-v2.txt")
					? new Response(manifest)
					: new Response(archive),
			);
			const ownership = {
				kind: "native" as const,
				prefix,
				versionsRoot: join(prefix, "share", "clawdi", "versions"),
				versionDir: join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64"),
				version: "1.2.3",
				target: "linux-x64" as const,
				executable: join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64", "clawdi"),
				launcher: join(prefix, "bin", "clawdi"),
			};
			const { restore } = mockFetch([
				{
					method: "GET",
					path: "/-/package/clawdi/dist-tags",
					response: () => jsonResponse(releaseTags("99.0.0")),
				},
			]);
			process.env.CLAWDI_NATIVE_PROBE_LOG = probeLog;
			try {
				const { stdout } = await captureOutput(() =>
					withStdoutTty(
						() =>
							update(
								{ yes },
								{
									detectOwnership: () => ownership,
									nativeReleaseBaseUrl: "https://example.invalid/clawdi-cli-v99.0.0",
									nativeFetcher,
								},
							),
						!yes,
					),
				);
				if (yes) expect(JSON.parse(stdout)).toMatchObject({ latest: "99.0.0", installed: true });
				expect(process.exitCode).toBe(0);
			} finally {
				delete process.env.CLAWDI_NATIVE_PROBE_LOG;
				restore();
			}
			const [commandPath, ...args] = readFileSync(probeLog, "utf8").trim().split("\n");
			expect(commandPath).toMatch(/\/share\/clawdi\/\.stage-[^/]+\/clawdi$/);
			const stageIndex = args.indexOf("--native-stage");
			expect(stageIndex).toBeGreaterThan(-1);
			expect(args[stageIndex + 1]).toBe(dirname(commandPath ?? ""));
			expect(args).toContain("--native-activate");
			expect(
				args.slice(args.indexOf("--native-prefix"), args.indexOf("--native-prefix") + 2),
			).toEqual(["--native-prefix", prefix]);
			expect(
				args.slice(args.indexOf("--native-version"), args.indexOf("--native-version") + 2),
			).toEqual(["--native-version", "99.0.0"]);
			expect(
				args.slice(args.indexOf("--native-target"), args.indexOf("--native-target") + 2),
			).toEqual(["--native-target", "linux-x64"]);
		},
	);

	it("uses safe Windows command vectors for exact npm install and owned executable smoke", async () => {
		const installs: { command: string; args: string[] }[] = [];
		const smokes: { command: string; args: string[] }[] = [];
		const ownership = {
			kind: "package" as const,
			installer: "npm" as const,
			installerExecutable: "C:\\Program Files\\npm\\npm.cmd",
			executable: "C:\\Program Files\\npm\\clawdi.cmd",
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse(releaseTags("99.0.0")),
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
				args: ["/d", "/s", "/c", ownership.installerExecutable, "i", "-g", "clawdi@99.0.0"],
			},
		]);
		expect(smokes).toEqual([
			{
				command: "cmd.exe",
				args: ["/d", "/s", "/c", ownership.executable, "--version"],
			},
		]);
		expect(process.exitCode).toBe(0);
	});

	it("does not claim success when the owned executable reports another version", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse(releaseTags("99.0.0")),
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
		const orig = console.error;
		let captured = "";
		console.error = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse(releaseTags("99.0.0")),
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
			console.error = orig;
			restore();
		}
		expect(captured).toContain("Automatic update is unsupported");
		expect(captured).toContain(
			"curl -fsSL https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v99.0.0/install.sh | CLAWDI_VERSION=99.0.0 sh",
		);
	});

	it("uses the shared fenced update lease and never reclaims an old live owner", async () => {
		const lockDir = join(tmpHome, ".clawdi", "update.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			JSON.stringify({
				schemaVersion: "clawdi.privateDirectoryLockOwner.v1",
				pid: process.pid,
				acquiredAt: "2000-01-01T00:00:00.000Z",
				token: "live-update-owner",
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse(releaseTags("99.0.0")),
			},
		]);
		try {
			await withStdoutTty(() =>
				update(
					{},
					{
						detectOwnership: () => npmOwnership,
						lockOptions: { timeoutMs: 0, staleMs: 1 },
						installRunner: () => {
							throw new Error("live owner must fence the manual installer");
						},
					},
				),
			);
		} finally {
			restore();
		}
		expect(process.exitCode).toBe(1);
		expect(JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")).token).toBe(
			"live-update-owner",
		);
	});
});

describe("release age policy", () => {
	it("records first discovery once and installs only at the 24 hour boundary", async () => {
		let now = Date.parse("2026-10-07T00:00:00Z");
		const firstSeen = new Date(now).toISOString();
		const calls: string[][] = [];
		const { captured, restore } = mockFetch([
			{
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
			},
		]);
		const options = {
			currentVersion: "1.2.3",
			ownership: npmOwnership,
			now: () => now,
			installRunner: async (_installer: string, args: string[]) => {
				calls.push(args);
				return 0;
			},
			versionReader: () => "1.2.4",
		};
		try {
			expect(await daemonAutoUpdateOnce(options)).toBe("no_update");
			expect(captured[0]?.url).toBe("https://registry.npmjs.org/-/package/clawdi/dist-tags");
			now += AUTO_UPDATE_MIN_AGE_MS - 1;
			expect(await daemonAutoUpdateOnce(options)).toBe("no_update");
			expect(readUpdateCache().firstSeen).toEqual([{ version: "1.2.4", firstSeenAt: firstSeen }]);
			now += 1;
			expect(await daemonAutoUpdateOnce(options)).toBe("installed");
			expect(calls).toEqual([["i", "-g", "clawdi@1.2.4"]]);
		} finally {
			restore();
		}
	});

	it.each(["daemon", "background"])(
		"%s skips intermediate releases for the newest eligible version",
		async (path) => {
			const now = Date.now();
			seedObservedVersions(
				"1.2.7",
				[
					{ version: "1.2.5", age: AUTO_UPDATE_MIN_AGE_MS + 1 },
					{ version: "1.2.4", age: AUTO_UPDATE_MIN_AGE_MS * 2 },
					{ version: "1.2.7", age: 1 },
					{ version: "1.2.6", age: AUTO_UPDATE_MIN_AGE_MS },
				],
				now,
			);
			const calls: string[][] = [];
			const runtime = {
				ownership: npmOwnership,
				now: () => now,
				installRunner: async (_installer: string, args: string[]) => {
					calls.push(args);
					return 0;
				},
				versionReader: () => "1.2.6",
			};
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () => jsonResponse({ latest: "1.2.7" }),
				},
			]);
			try {
				const result =
					path === "daemon"
						? await daemonAutoUpdateOnce({ currentVersion: "1.2.3", ...runtime })
						: await runBackgroundUpdateWorker({ currentVersion: "1.2.3" }, runtime);
				expect(result).toBe("installed");
				expect(calls).toEqual([["i", "-g", "clawdi@1.2.6"]]);
			} finally {
				restore();
			}
		},
	);

	it("background discovery waits a day and foreground startup stays silent before eligibility", async () => {
		const now = Date.now();
		const { restore } = mockFetch([
			{
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "999.0.0" }),
			},
		]);
		try {
			expect(
				await runBackgroundUpdateWorker(
					{ currentVersion: "1.2.3" },
					{
						ownership: npmOwnership,
						now: () => now,
						installRunner: async () => {
							throw new Error("fresh releases must not install");
						},
					},
				),
			).toBe("no_update");
			const { stdout } = await captureOutput(() =>
				withStdoutTty(() =>
					maybeAutoUpdate({
						now: () => now,
						detectOwnership: () => npmOwnership,
						spawnBackgroundWorker: () => {
							throw new Error("fresh cache needs no worker");
						},
					}),
				),
			);
			expect(stdout).not.toContain("in background");
		} finally {
			restore();
		}
	});

	it.each(["1.2.4", "1.2.5"])(
		"never downgrades or reinstalls current %s",
		async (currentVersion) => {
			seedObservedVersions("1.2.4", [{ version: "1.2.4", age: AUTO_UPDATE_MIN_AGE_MS }]);
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () => jsonResponse({ latest: "1.2.4" }),
				},
			]);
			const runtime = {
				ownership: npmOwnership,
				installRunner: async () => {
					throw new Error("must not downgrade or reinstall");
				},
			};
			try {
				expect(await daemonAutoUpdateOnce({ currentVersion, ...runtime })).toBe("no_update");
				expect(await runBackgroundUpdateWorker({ currentVersion }, runtime)).toBe("no_update");
			} finally {
				restore();
			}
		},
	);

	it("manual --yes installs latest immediately and records its first observation", async () => {
		const now = Date.now();
		const calls: string[][] = [];
		const { restore } = mockFetch([
			{
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "99.0.0" }),
			},
		]);
		try {
			await captureOutput(() =>
				withStdoutTty(
					() =>
						update(
							{ yes: true },
							{
								now: () => now,
								detectOwnership: () => npmOwnership,
								installRunner: (_command, args) => {
									calls.push(args);
									return 0;
								},
								versionReader: () => "99.0.0",
							},
						),
					false,
				),
			);
			expect(calls).toEqual([["i", "-g", "clawdi@99.0.0"]]);
			expect(readUpdateCache().firstSeen).toEqual([
				{ version: "99.0.0", firstSeenAt: new Date(now).toISOString() },
			]);
		} finally {
			restore();
		}
	});

	it("bounds history while retaining the newest aged candidate during frequent releases", async () => {
		const now = Date.now();
		seedObservedVersions("1.0.0", [{ version: "1.0.0", age: AUTO_UPDATE_MIN_AGE_MS }], now);
		let latest = "1.0.0";
		const { restore } = mockFetch([
			{
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest }),
			},
		]);
		try {
			await captureOutput(async () => {
				for (let i = 1; i <= 20; i++) {
					latest = `1.0.${i}`;
					await update({ check: true, json: true }, { now: () => now });
				}
			});
			expect(readUpdateCache().firstSeen).toHaveLength(8);
			expect(readUpdateCache().firstSeen.map(({ version }) => version)).toContain("1.0.0");
			expect(readUpdateCache().firstSeen[0]?.version).toBe("1.0.20");
		} finally {
			restore();
		}
	});

	it("starts a new observation for legacy caches and ignores malformed timestamps", async () => {
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: "1.2.4",
				firstSeen: [{ version: "1.2.4", firstSeenAt: "invalid" }, null],
			}),
		);
		expect(await daemonAutoUpdateOnce({ currentVersion: "1.2.3", ownership: npmOwnership })).toBe(
			"no_update",
		);
		expect(readUpdateCache().firstSeen).toHaveLength(1);
	});
});

describe("bounded dist-tags response", () => {
	it.each(["oversized body", "oversized length", "invalid JSON", "full packument"])(
		"rejects %s",
		async (kind) => {
			const { restore } = mockFetch([
				{
					path: "/-/package/clawdi/dist-tags",
					response: () =>
						kind === "oversized body"
							? new Response(" ".repeat(65537))
							: kind === "oversized length"
								? new Response('{"latest":"99.0.0"}', { headers: { "content-length": "65537" } })
								: kind === "invalid JSON"
									? new Response("{")
									: jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
				},
			]);
			try {
				const { stdout } = await captureOutput(() => update({ check: true, json: true }));
				expect(JSON.parse(stdout).latest).toBeNull();
				expect(process.exitCode).toBe(1);
			} finally {
				restore();
			}
		},
	);
});

describe("daemonAutoUpdateOnce", () => {
	beforeEach(() =>
		seedObservedVersions("1.2.4", [{ version: "1.2.4", age: AUTO_UPDATE_MIN_AGE_MS }]),
	);
	it("runs a startup request through exact install and owned executable validation", async () => {
		const calls: Array<{ installer: string; args: string[] }> = [];
		const result = await runBackgroundUpdateWorker(
			{ currentVersion: "1.2.3" },
			{
				ownership: npmOwnership,
				installRunner: async (installer, args) => {
					calls.push({ installer, args });
					return 0;
				},
				versionReader: (executable) => (executable === npmOwnership.executable ? "1.2.4" : null),
			},
		);
		expect(result).toBe("installed");
		expect(calls).toEqual([{ installer: "npm", args: ["i", "-g", "clawdi@1.2.4"] }]);
	});

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
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
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

	it("auto-installs aged major updates from daemon context", async () => {
		seedObservedVersions("2.0.0", [{ version: "2.0.0", age: AUTO_UPDATE_MIN_AGE_MS }]);
		const calls: { installer: string; args: string[] }[] = [];
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "2.0.0" }),
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

	it("uses latest for prerelease clients without downgrading to a stale beta tag", async () => {
		seedObservedVersions("1.2.3", [{ version: "1.2.3", age: AUTO_UPDATE_MIN_AGE_MS }]);
		const calls: string[][] = [];
		const { restore } = mockFetch([
			{
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.3", beta: "1.2.2-beta.1" }),
			},
		]);
		try {
			expect(
				await daemonAutoUpdateOnce({
					currentVersion: "1.2.3-rc.2",
					ownership: npmOwnership,
					installRunner: async (_installer, args) => {
						calls.push(args);
						return 0;
					},
					versionReader: () => "1.2.3",
				}),
			).toBe("installed");
			expect(calls).toEqual([["i", "-g", "clawdi@1.2.3"]]);
		} finally {
			restore();
		}
	});

	it("normalizes legacy autoUpdate=false for daemon auto-update", async () => {
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

	it("uses the shared updater lock for daemon and startup workers", async () => {
		const lockDir = join(tmpHome, ".clawdi", "update.lock");
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(
			join(lockDir, "owner.json"),
			JSON.stringify({
				schemaVersion: "clawdi.privateDirectoryLockOwner.v1",
				pid: process.pid,
				acquiredAt: "2000-01-01T00:00:00.000Z",
				token: "live-update-owner",
			}),
		);
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
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
			expect(
				await runBackgroundUpdateWorker(
					{ currentVersion: "1.2.3" },
					{
						ownership: npmOwnership,
						installRunner: async () => {
							throw new Error("startup worker must use the same lock");
						},
					},
				),
			).toBe("locked");
		} finally {
			restore();
		}
	});

	it("fails validation when the owned executable is not the resolved version", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
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
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
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
				path: "/-/package/clawdi/dist-tags",
				response: () => jsonResponse({ latest: "1.2.4" }),
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

	it("restarts when an external native activation swaps the stable launcher target", async () => {
		const binDir = join(tmpHome, "prefix", "bin");
		const versionsDir = join(tmpHome, "prefix", "share", "clawdi", "versions");
		mkdirSync(binDir, { recursive: true });
		mkdirSync(join(versionsDir, "1.2.3-linux-x64"), { recursive: true });
		mkdirSync(join(versionsDir, "1.2.4-linux-x64"), { recursive: true });
		const launcher = join(binDir, "clawdi");
		symlinkSync("../share/clawdi/versions/1.2.3-linux-x64/clawdi", launcher);
		const abort = new AbortController();
		const restart = createRestartCoordination(abort);
		await startAutoRestart({ abort, restart, entryPath: launcher, pollMs: 5 });
		const restarted = new Promise<void>((resolve) => {
			abort.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		const replacement = join(binDir, ".clawdi-new");
		symlinkSync("../share/clawdi/versions/1.2.4-linux-x64/clawdi", replacement);
		renameSync(replacement, launcher);
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
					spawnBackgroundWorker: () => {
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
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: "999.0.0",
				firstSeen: [
					{
						version: "999.0.0",
						firstSeenAt: new Date(Date.now() - AUTO_UPDATE_MIN_AGE_MS).toISOString(),
					},
				],
			}),
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
					spawnBackgroundWorker: () => {
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
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: "999.0.0",
				firstSeen: [
					{
						version: "999.0.0",
						firstSeenAt: new Date(Date.now() - AUTO_UPDATE_MIN_AGE_MS).toISOString(),
					},
				],
			}),
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
					spawnBackgroundWorker: () => {
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

	it("delegates first-run discovery without waiting for a registry request", async () => {
		const workers: Array<{ current: string }> = [];
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await withStdoutTty(() =>
				maybeAutoUpdate({
					detectOwnership: () => npmOwnership,
					spawnBackgroundWorker: (request) => workers.push(request),
				}),
			);
		} finally {
			restore();
		}
		expect(fetches).toHaveLength(0);
		expect(workers).toHaveLength(1);
		expect(workers[0]?.current).toBe(getCliVersion());
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
					detectOwnership: () => null,
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
		// Plant cache with a version way higher than package.json so this
		// remains a major-bump test regardless of the fixture version.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: "999.0.0",
				firstSeen: [
					{
						version: "999.0.0",
						firstSeenAt: new Date(Date.now() - AUTO_UPDATE_MIN_AGE_MS).toISOString(),
					},
				],
			}),
		);
		const workers: {
			current: string;
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
					spawnBackgroundWorker: (request) => {
						workers.push(request);
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
		expect(workers).toHaveLength(1);
		expect(workers[0]?.current).toBe(getCliVersion());
		expect(workers[0]?.logFd ?? -1).toBeGreaterThanOrEqual(0);
	});

	it("normalizes legacy autoUpdate=false before the startup install path", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "config.json"), JSON.stringify({ autoUpdate: "false" }));
		// Cache says a newer version is available.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({
				checkedAt: new Date().toISOString(),
				latest: "999.0.0",
				firstSeen: [
					{
						version: "999.0.0",
						firstSeenAt: new Date(Date.now() - AUTO_UPDATE_MIN_AGE_MS).toISOString(),
					},
				],
			}),
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

async function runNativeForegroundFailure(fetcher: typeof fetch, timeoutMs?: number, yes = false) {
	const prefix = join(tmpHome, "prefix");
	const ownership = {
		kind: "native" as const,
		prefix,
		versionsRoot: join(prefix, "share", "clawdi", "versions"),
		versionDir: join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64"),
		version: "1.2.3",
		target: "linux-x64" as const,
		executable: join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64", "clawdi"),
		launcher: join(prefix, "bin", "clawdi"),
	};
	const { restore } = mockFetch([
		{
			method: "GET",
			path: "/-/package/clawdi/dist-tags",
			response: () => jsonResponse(releaseTags("99.0.0")),
		},
	]);
	try {
		return await captureOutput(() =>
			withStdoutTty(
				() =>
					update(
						{ yes },
						{
							detectOwnership: () => ownership,
							nativeReleaseBaseUrl: "https://example.invalid/clawdi-cli-v99.0.0",
							nativeFetcher: fetcher,
							nativeDownloadTimeoutMs: timeoutMs,
						},
					),
				!yes,
			),
		);
	} finally {
		restore();
	}
}

function nativeManifest(version: string, linuxX64Sha: string): string {
	return [
		"clawdi.nativeRelease.v2",
		`version\t${version}`,
		...NATIVE_TARGETS.map((target: NativeTarget, index) => {
			const sha = target === "linux-x64" ? linuxX64Sha : String(index).repeat(64);
			return `artifact\t${target}\t${nativeAssetName(target)}\t${sha}`;
		}),
		"",
	].join("\n");
}

function testFetcher(
	implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: fetch.preconnect });
}

function releaseTags(version: string): { latest: string } {
	return { latest: version };
}

function writeDaemonHealth(agent: string, version: string): void {
	const dir = join(tmpHome, ".clawdi", "serve", agent);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "health"),
		`${JSON.stringify({ timestamp: new Date().toISOString(), version })}\n`,
	);
}

async function waitForPath(path: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			readFileSync(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	throw new Error(`timed out waiting for ${path}`);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function seedObservedVersions(
	latest: string,
	entries: Array<{ version: string; age: number }>,
	now = Date.now(),
) {
	writeFileSync(
		join(tmpHome, ".clawdi", "update.json"),
		JSON.stringify({
			checkedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
			latest,
			firstSeen: entries.map(({ version, age }) => ({
				version,
				firstSeenAt: new Date(now - age).toISOString(),
			})),
		}),
	);
}

function readUpdateCache(): { firstSeen: Array<{ version: string; firstSeenAt: string }> } {
	return JSON.parse(readFileSync(join(tmpHome, ".clawdi", "update.json"), "utf8"));
}
