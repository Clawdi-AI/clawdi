import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildNumericUserCommand,
	buildRuntimeUserCommand,
	clearTenantToolLocationOverrides,
	commandExists,
	createPrivilegeDropResolver,
	runRuntimeUserCommand,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";

test("command existence follows shell resolution", () => {
	expect(commandExists("command")).toBe(true);
	expect(commandExists("clawdi-command-that-does-not-exist")).toBe(false);
});

test("tenant tools inherit HOME but not platform location overrides", () => {
	const env: NodeJS.ProcessEnv = {
		HOME: "/home/clawdi",
		NPM_CONFIG_PREFIX: "/platform/npm",
		npm_config_cache: "/platform/cache",
		XDG_CONFIG_HOME: "/platform/config",
		XDG_CACHE_HOME: "/platform/xdg-cache",
		XDG_DATA_HOME: "/platform/data",
		XDG_STATE_HOME: "/platform/state",
		HERMES_HOME: "/platform/hermes",
		UV_CACHE_DIR: "/platform/uv-cache",
		UV_PYTHON_INSTALL_DIR: "/platform/python",
		UV_PYTHON_BIN_DIR: "/platform/python-bin",
		UV_TOOL_DIR: "/platform/uv-tools",
		UV_TOOL_BIN_DIR: "/platform/uv-tool-bin",
		UV_MANAGED_PYTHON: "1",
		CLAWDI_API_URL: "https://api.example.test",
	};

	clearTenantToolLocationOverrides(env);

	expect(env).toEqual({
		HOME: "/home/clawdi",
		CLAWDI_API_URL: "https://api.example.test",
	});
});

test("isolated runtime commands override and clear native state locations", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-user-isolation-"));
	const output = join(root, "environment.json");
	const previousOpenClawState = process.env.OPENCLAW_STATE_DIR;
	const previousOpenClawConfig = process.env.OPENCLAW_CONFIG_PATH;
	const previousHermesHome = process.env.HERMES_HOME;
	const previousHermesProfile = process.env.HERMES_PROFILE;
	const previousHermesConfig = process.env.HERMES_CONFIG;
	const previousHermesEnv = process.env.HERMES_ENV;
	try {
		process.env.OPENCLAW_STATE_DIR = "/live/openclaw";
		process.env.OPENCLAW_CONFIG_PATH = "/live/openclaw.json";
		process.env.HERMES_HOME = "/live/hermes";
		process.env.HERMES_PROFILE = "live-profile";
		process.env.HERMES_CONFIG = "/live/hermes-config.yaml";
		process.env.HERMES_ENV = "/live/hermes.env";
		const result = spawnRuntimeUserCommand(
			process.execPath,
			[
				"-e",
				`require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify({ home: process.env.HOME, openclawState: process.env.OPENCLAW_STATE_DIR, openclawConfig: process.env.OPENCLAW_CONFIG_PATH ?? null, hermesHome: process.env.HERMES_HOME, hermesProfile: process.env.HERMES_PROFILE ?? null, hermesConfig: process.env.HERMES_CONFIG ?? null, hermesEnv: process.env.HERMES_ENV ?? null }))`,
			],
			root,
			root,
			{
				environmentOverrides: {
					OPENCLAW_STATE_DIR: join(root, "openclaw"),
					OPENCLAW_CONFIG_PATH: undefined,
					HERMES_HOME: join(root, "hermes"),
					HERMES_PROFILE: undefined,
					HERMES_CONFIG: undefined,
					HERMES_ENV: undefined,
				},
			},
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
			home: root,
			openclawState: join(root, "openclaw"),
			openclawConfig: null,
			hermesHome: join(root, "hermes"),
			hermesProfile: null,
			hermesConfig: null,
			hermesEnv: null,
		});
	} finally {
		if (previousOpenClawState === undefined) delete process.env.OPENCLAW_STATE_DIR;
		else process.env.OPENCLAW_STATE_DIR = previousOpenClawState;
		if (previousOpenClawConfig === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
		else process.env.OPENCLAW_CONFIG_PATH = previousOpenClawConfig;
		if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
		else process.env.HERMES_HOME = previousHermesHome;
		if (previousHermesProfile === undefined) delete process.env.HERMES_PROFILE;
		else process.env.HERMES_PROFILE = previousHermesProfile;
		if (previousHermesConfig === undefined) delete process.env.HERMES_CONFIG;
		else process.env.HERMES_CONFIG = previousHermesConfig;
		if (previousHermesEnv === undefined) delete process.env.HERMES_ENV;
		else process.env.HERMES_ENV = previousHermesEnv;
		rmSync(root, { recursive: true, force: true });
	}
});

const NUMERIC_PRIVILEGE_TOOL = ["set", "priv"].join("");
const ACCOUNT_PRIVILEGE_TOOL = ["run", "user"].join("");
const SHELL_PRIVILEGE_TOOL = ["s", "u"].join("");

describe("privilege-drop resolver", () => {
	for (const mechanism of [
		NUMERIC_PRIVILEGE_TOOL,
		ACCOUNT_PRIVILEGE_TOOL,
		SHELL_PRIVILEGE_TOOL,
	] as const) {
		test(`selects ${mechanism} when it is the available mechanism`, () => {
			const resolver = createPrivilegeDropResolver((candidate) => candidate === mechanism);
			expect(
				String(
					resolver.resolve({
						currentUid: 0,
						targetUid: 10_001,
						targetUser: "clawdi",
						targetKind: "named",
					}),
				),
			).toBe(mechanism);
		});
	}

	test("uses no external mechanism when the target uid is already effective", () => {
		const resolver = createPrivilegeDropResolver(() => {
			throw new Error("availability must not be probed");
		});
		expect(
			resolver.resolve({
				currentUid: 10_001,
				targetUid: 10_001,
				targetUser: "clawdi",
				targetKind: "named",
			}),
		).toBe("none");
	});

	test("reports a mechanism-independent error when none is available", () => {
		const resolver = createPrivilegeDropResolver(() => false);
		expect(() =>
			resolver.resolve({
				currentUid: 0,
				targetUid: 10_001,
				targetUser: "clawdi",
				targetKind: "named",
			}),
		).toThrow("cannot drop privileges to clawdi: no supported mechanism");
	});

	test("caches failed availability probes and the resolved mechanism", () => {
		const probes: string[] = [];
		const resolver = createPrivilegeDropResolver((candidate) => {
			probes.push(candidate);
			return candidate === ACCOUNT_PRIVILEGE_TOOL;
		});
		const input = {
			currentUid: 0,
			targetUid: 10_001,
			targetUser: "clawdi",
			targetKind: "named" as const,
		};

		expect(String(resolver.resolve(input))).toBe(ACCOUNT_PRIVILEGE_TOOL);
		expect(String(resolver.resolve(input))).toBe(ACCOUNT_PRIVILEGE_TOOL);
		expect(probes).toEqual([NUMERIC_PRIVILEGE_TOOL, ACCOUNT_PRIVILEGE_TOOL]);
	});
});

describe("privilege-drop command descriptors", () => {
	test("builds a named-user setpriv command", () => {
		const child = buildRuntimeUserCommand(
			"clawdi",
			"/home/clawdi",
			"test",
			["-r", "/run/clawdi/ca.pem"],
			{
				currentUid: 0,
				runtimeUid: 10_001,
				runtimeGid: 10_001,
				resolver: createPrivilegeDropResolver((candidate) => candidate === NUMERIC_PRIVILEGE_TOOL),
			},
		);
		expect(child).toEqual({
			command: NUMERIC_PRIVILEGE_TOOL,
			args: [
				"--reuid=10001",
				"--regid=10001",
				"--init-groups",
				"--",
				"env",
				"HOME=/home/clawdi",
				"USER=clawdi",
				"LOGNAME=clawdi",
				"test",
				"-r",
				"/run/clawdi/ca.pem",
			],
			env: {
				HOME: "/home/clawdi",
				USER: "clawdi",
				LOGNAME: "clawdi",
			},
		});
	});

	test("builds a numeric-identity setpriv command", () => {
		const child = buildNumericUserCommand(10_002, 10_003, "/opt/mitmdump", [], {
			currentUid: 0,
			resolver: createPrivilegeDropResolver((candidate) => candidate === NUMERIC_PRIVILEGE_TOOL),
		});
		expect(child).toEqual({
			command: NUMERIC_PRIVILEGE_TOOL,
			args: ["--reuid=10002", "--regid=10003", "--clear-groups", "--", "/opt/mitmdump"],
		});
	});

	test("leaves an already-correct uid command unwrapped without resolving a gid", () => {
		const child = buildRuntimeUserCommand(
			"missing-user",
			"/runtime/home",
			"test",
			["-r", "/tmp/file"],
			{
				currentUid: 12_345,
				runtimeUid: 12_345,
				resolver: createPrivilegeDropResolver(() => false),
			},
		);
		expect(child).toEqual({
			command: "test",
			args: ["-r", "/tmp/file"],
			env: {
				HOME: "/runtime/home",
				USER: "missing-user",
				LOGNAME: "missing-user",
			},
		});
	});

	for (const mechanism of [
		NUMERIC_PRIVILEGE_TOOL,
		ACCOUNT_PRIVILEGE_TOOL,
		SHELL_PRIVILEGE_TOOL,
	] as const) {
		test(`applies the same child identity environment with ${mechanism}`, () => {
			const child = buildRuntimeUserCommand("clawdi", "/srv/clawdi", "printenv", [], {
				currentUid: 0,
				runtimeUid: 10_001,
				runtimeGid: 10_001,
				resolver: createPrivilegeDropResolver((candidate) => candidate === mechanism),
			});
			const envIndex = child.args.lastIndexOf("env");
			expect(child.args.slice(envIndex)).toEqual([
				"env",
				"HOME=/srv/clawdi",
				"USER=clawdi",
				"LOGNAME=clawdi",
				"printenv",
			]);
			expect(child.env).toEqual({
				HOME: "/srv/clawdi",
				USER: "clawdi",
				LOGNAME: "clawdi",
			});
		});
	}
});

describe("runtime user command timeout", () => {
	test("bounds synchronous runtime-user commands", () => {
		expect(() =>
			runRuntimeUserCommand("bash", ["-c", "while :; do :; done"], "", tmpdir(), tmpdir(), {
				timeoutMs: 20,
			}),
		).toThrow();
	});

	test("reports a bounded runtime-user probe timeout", () => {
		const result = spawnRuntimeUserCommand(
			"bash",
			["-c", "while :; do :; done"],
			tmpdir(),
			tmpdir(),
			{ timeoutMs: 20 },
		);
		expect(result.status).toBeNull();
		expect(result.error?.message).toContain("ETIMEDOUT");
	});
});
