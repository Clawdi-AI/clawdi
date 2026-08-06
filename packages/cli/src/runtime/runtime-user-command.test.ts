import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
	buildNumericUserCommand,
	buildRuntimeUserCommand,
	commandExists,
	createPrivilegeDropResolver,
	runRuntimeUserCommand,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";

test("command existence follows shell resolution", () => {
	expect(commandExists("command")).toBe(true);
	expect(commandExists("clawdi-command-that-does-not-exist")).toBe(false);
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
