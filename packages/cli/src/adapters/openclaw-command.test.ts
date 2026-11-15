import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
	OpenClawSdkExitError,
	runOpenClawCommand,
	runOpenClawSdkCommand,
} from "./openclaw-command";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sdkFixture(source: string, root?: string, runtimeConfigSource?: string): string {
	const packageRoot = root ? join(root, "openclaw") : mkdtempSync(".projection-rev7-sdk-");
	if (!root) roots.push(packageRoot);
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "openclaw",
			type: "module",
			exports: {
				"./plugin-sdk/session-transcript-runtime": "./sdk.mjs",
				...(runtimeConfigSource === undefined
					? {}
					: { "./plugin-sdk/runtime-config-snapshot": "./runtime-config-snapshot.mjs" }),
			},
		}),
	);
	if (runtimeConfigSource !== undefined) {
		writeFileSync(join(packageRoot, "runtime-config-snapshot.mjs"), runtimeConfigSource);
	}
	const path = join(packageRoot, "sdk.mjs");
	writeFileSync(path, source);
	return path;
}

const params = { agentId: "main", sessionId: "fixture", sessionKey: "agent:main:main" };

describe("OpenClaw transcript SDK command", () => {
	test.each([false, true])(
		"uses system Node with setpriv (parent tenant bins: %s)",
		async (tenantBinsInPath) => {
			const root = mkdtempSync(join(tmpdir(), "projection-rev7-runtime-user-"));
			roots.push(root);
			chmodSync(root, 0o755);
			const bin = join(root, "bin");
			mkdirSync(bin);
			const tenantBin = join(root, ".local", "bin");
			mkdirSync(tenantBin, { recursive: true });
			const openclawBin = join(root, ".openclaw", "bin");
			mkdirSync(openclawBin, { recursive: true });
			chmodSync(bin, 0o755);
			const commandOutput = join(root, "command-env.txt");
			writeFileSync(commandOutput, "", { mode: 0o666 });
			chmodSync(commandOutput, 0o666);
			const setprivArgs = join(root, "setpriv-args.txt");
			writeFileSync(setprivArgs, "", { mode: 0o666 });
			chmodSync(setprivArgs, 0o666);
			const privilegeDropBinary = ["set", "priv"].join("");
			writeFileSync(
				join(bin, privilegeDropBinary),
				`#!/bin/sh
printf '%s\\n' "$*" > "$CLAWDI_SET_PRIV_ARGS"
while [ "$1" != "--" ]; do shift; done
shift
export CLAWDI_TEST_SETUID=65534
exec "$@"
`,
				{ mode: 0o755 },
			);
			for (const directory of [tenantBin, openclawBin]) {
				writeFileSync(join(directory, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
			}
			writeFileSync(
				join(tenantBin, "openclaw"),
				`#!/bin/sh
printf '%s|%s|%s|%s|%s|%s|%s\\n' "$CLAWDI_TEST_SETUID" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$HOME" "$USER" "$PATH" "$(pwd)" > "$CLAWDI_TEST_OUTPUT"
printf '{"ok":true}\\n'
`,
				{ mode: 0o755 },
			);
			const sdkPath = sdkFixture(
				`console.log("sdk stdout log");
export function readVisibleSessionTranscriptMessageEntries() {
  return [{ entryId: "runtime-user", message: { role: "user", content: JSON.stringify({ marker: process.env.CLAWDI_TEST_SETUID ?? null, state: process.env.OPENCLAW_STATE_DIR ?? null, config: process.env.OPENCLAW_CONFIG_PATH ?? null, path: process.env.PATH, cwd: process.cwd() }) } }];
}
`,
				root,
			);

			const keys = [
				"CLAWDI_RUNTIME_USER",
				"CLAWDI_RUNTIME_UID",
				"CLAWDI_RUNTIME_GID",
				"CLAWDI_TEST_OUTPUT",
				"CLAWDI_SET_PRIV_ARGS",
				"OPENCLAW_STATE_DIR",
				"OPENCLAW_CONFIG_PATH",
				"HOME",
				"PATH",
			] as const;
			const previous = new Map(keys.map((key) => [key, process.env[key]]));
			const originalGetuid = process.getuid;
			const originalGeteuid = process.geteuid;
			try {
				process.env.CLAWDI_RUNTIME_USER = "projection-agent";
				process.env.CLAWDI_RUNTIME_UID = "65534";
				process.env.CLAWDI_RUNTIME_GID = "65534";
				process.env.CLAWDI_TEST_OUTPUT = commandOutput;
				process.env.CLAWDI_SET_PRIV_ARGS = setprivArgs;
				const inheritedState = "/persisted/openclaw-state";
				const inheritedConfig = "/persisted/openclaw-config.json";
				process.env.OPENCLAW_STATE_DIR = inheritedState;
				process.env.OPENCLAW_CONFIG_PATH = inheritedConfig;
				process.env.HOME = root;
				const systemPath = `${bin}:/usr/local/bin:/usr/bin:/bin`;
				process.env.PATH = tenantBinsInPath
					? `${tenantBin}:${openclawBin}:${systemPath}`
					: systemPath;
				Object.defineProperty(process, "getuid", { configurable: true, value: () => 0 });
				Object.defineProperty(process, "geteuid", { configurable: true, value: () => 0 });

				expect(await runOpenClawCommand(["--json"], { timeout: 5000, maxBuffer: 4096 })).toBe(
					'{"ok":true}\n',
				);
				expect(readFileSync(commandOutput, "utf8").trim().split("|")).toEqual([
					"65534",
					inheritedState,
					inheritedConfig,
					root,
					"projection-agent",
					systemPath,
					root,
				]);
				const commandDropArgs = readFileSync(setprivArgs, "utf8");
				expect(commandDropArgs).toContain("--reuid=65534");
				expect(commandDropArgs).toContain(join(tenantBin, "openclaw"));
				expect(commandDropArgs).not.toContain(`PATH=${tenantBin}`);

				const entries = JSON.parse(
					await runOpenClawSdkCommand(
						sdkPath,
						{ agentId: "main", sessionId: "fixture", sessionKey: "agent:main:main" },
						{ timeout: 5000, maxBuffer: 4096 },
					),
				) as Array<{ entryId: string; message: { content: string } }>;
				expect(entries[0]?.entryId).toBe("runtime-user");
				expect(JSON.parse(entries[0]?.message.content ?? "null")).toEqual({
					marker: "65534",
					state: inheritedState,
					config: inheritedConfig,
					path: systemPath,
					cwd: root,
				});
				expect(readFileSync(setprivArgs, "utf8")).toContain("--reuid=65534");
				expect(readFileSync(setprivArgs, "utf8")).toContain(
					"node --max-old-space-size=256 --input-type=module -e",
				);

				delete process.env.OPENCLAW_STATE_DIR;
				delete process.env.OPENCLAW_CONFIG_PATH;
				expect(await runOpenClawCommand(["--json"], { timeout: 5000, maxBuffer: 4096 })).toBe(
					'{"ok":true}\n',
				);
				expect(readFileSync(commandOutput, "utf8").trim().split("|")).toEqual([
					"65534",
					"",
					"",
					root,
					"projection-agent",
					systemPath,
					root,
				]);
				const unsetEntries = JSON.parse(
					await runOpenClawSdkCommand(
						sdkPath,
						{ agentId: "main", sessionId: "fixture", sessionKey: "agent:main:main" },
						{ timeout: 5000, maxBuffer: 4096 },
					),
				) as Array<{ entryId: string; message: { content: string } }>;
				expect(JSON.parse(unsetEntries[0]?.message.content ?? "null")).toEqual({
					marker: "65534",
					state: null,
					config: null,
					path: systemPath,
					cwd: root,
				});
			} finally {
				Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
				Object.defineProperty(process, "geteuid", { configurable: true, value: originalGeteuid });
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);

	test.each([undefined, "root", "projection-agent"])(
		"uses PATH node for a native CLI SDK child (runtime user: %s)",
		async (runtimeUser) => {
			const root = mkdtempSync(join(tmpdir(), "openclaw-sdk-native-byo-"));
			roots.push(root);
			const bin = join(root, "bin");
			mkdirSync(bin);
			const originalExecPath = process.execPath;
			const nodePath = execFileSync("node", ["-p", "process.execPath"], {
				encoding: "utf8",
			}).trim();
			writeFileSync(
				join(bin, "node"),
				`#!/bin/sh
export CLAWDI_TEST_PATH_NODE=1
exec '${nodePath.replaceAll("'", "'\\''")}' "$@"
`,
				{ mode: 0o755 },
			);
			// A compiled Clawdi binary cannot evaluate the SDK's Node command line.
			const nativeCli = join(root, "clawdi");
			writeFileSync(nativeCli, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
			const sdkPath = sdkFixture(
				"export const readVisibleSessionTranscriptMessageEntries = () => [process.env.CLAWDI_TEST_PATH_NODE];",
				root,
			);
			const keys = [
				"HOME",
				"PATH",
				"CLAWDI_RUNTIME_USER",
				"CLAWDI_RUNTIME_UID",
				"CLAWDI_RUNTIME_GID",
			] as const;
			const previous = new Map(keys.map((key) => [key, process.env[key]]));
			try {
				process.env.HOME = root;
				process.env.PATH = `${bin}:/usr/bin:/bin`;
				process.env.CLAWDI_RUNTIME_UID = String(userInfo().uid);
				process.env.CLAWDI_RUNTIME_GID = String(userInfo().gid);
				if (runtimeUser === undefined) delete process.env.CLAWDI_RUNTIME_USER;
				else process.env.CLAWDI_RUNTIME_USER = runtimeUser;
				Object.defineProperty(process, "execPath", { value: nativeCli });
				expect(
					JSON.parse(
						await runOpenClawSdkCommand(sdkPath, params, { timeout: 5000, maxBuffer: 4096 }),
					),
				).toEqual(["1"]);
			} finally {
				Object.defineProperty(process, "execPath", { value: originalExecPath });
				for (const [key, value] of previous) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);

	test.each([undefined, "export const unsupported = true;"])(
		"reads logged SDK entries with optional config reader absent (%s)",
		async (runtimeConfigSource) => {
			const entries = [{ entryId: "fixture-user", message: { role: "user", content: "Prompt" } }];
			const path = sdkFixture(
				`
			console.log("[state/agent-db] agent database integrity gate");
			export function readVisibleSessionTranscriptMessageEntries(params) {
				if (params.sessionId !== "fixture") throw new Error("wrong SDK params");
				return ${JSON.stringify(entries)};
			}
		`,
				undefined,
				runtimeConfigSource,
			);
			expect(
				JSON.parse(await runOpenClawSdkCommand(path, params, { timeout: 5000, maxBuffer: 4096 })),
			).toEqual(entries);
		},
	);

	test("bounds result memory and keeps the subprocess slot usable after failure", async () => {
		const path = sdkFixture(
			'export const readVisibleSessionTranscriptMessageEntries = () => ["x".repeat(10000)];',
		);
		await expect(
			runOpenClawSdkCommand(path, params, { timeout: 5000, maxBuffer: 128 }),
		).rejects.toThrow("buffer limit");
		writeFileSync(path, "export const readVisibleSessionTranscriptMessageEntries = () => [];");
		expect(await runOpenClawSdkCommand(path, params, { timeout: 5000 })).toBe("[]");
	});

	test("drains transcript results larger than the pipe capacity", async () => {
		const path = sdkFixture(
			'export const readVisibleSessionTranscriptMessageEntries = () => [{ entryId: "large", message: { role: "user", content: "x".repeat(1024 * 1024) } }];',
		);
		const result = await runOpenClawSdkCommand(path, params, {
			timeout: 5000,
			maxBuffer: 2 * 1024 * 1024,
		});
		expect(JSON.parse(result)).toEqual([
			{ entryId: "large", message: { role: "user", content: "x".repeat(1024 * 1024) } },
		]);
	});

	test("reports the missing export exit code", async () => {
		const path = sdkFixture("export const unsupported = true;");
		await expect(runOpenClawSdkCommand(path, params, { timeout: 5000 })).rejects.toBeInstanceOf(
			OpenClawSdkExitError,
		);
	});

	test("cancels an SDK read and waits for its subprocess to close", async () => {
		const path = sdkFixture(
			"export const readVisibleSessionTranscriptMessageEntries = () => new Promise(() => { setInterval(() => {}, 1000); });",
		);
		const controller = new AbortController();
		const running = runOpenClawSdkCommand(path, params, {
			timeout: 5000,
			signal: controller.signal,
		});
		const timer = setTimeout(() => controller.abort(), 100);
		try {
			await expect(running).rejects.toThrow();
		} finally {
			clearTimeout(timer);
		}
	});
});
