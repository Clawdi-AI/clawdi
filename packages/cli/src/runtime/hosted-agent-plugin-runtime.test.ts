import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	chownSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HostedAgentPluginRuntime,
	PreparedHostedAgentPlugin,
	PreparedHostedAgentPlugins,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	prepareHostedAgentPluginTransaction,
} from "./hosted-agent-plugin-runtime";
import { AGENT_PLUGINS_SCHEMA_1_0_0 } from "./manifest-resources";
import {
	enforceRuntimeUserOwnership,
	runtimeUserExistingOwnership,
	runtimeUserGid,
	runtimeUserUid,
} from "./runtime-user-command";

type CommandInput = Parameters<HostedAgentPluginCommandRunner["run"]>[0];

interface FakePluginState {
	name: string;
	nativeId: string;
	version: string;
	enabled: boolean;
	compatible: boolean;
	mcpServerNames?: string[];
}

const runtimeTestRoot = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-runtime-test-"));
let runtimeTestHomeSequence = 0;
afterAll(() => rmSync(runtimeTestRoot, { recursive: true, force: true }));

class FakeNativeRunner implements HostedAgentPluginCommandRunner {
	readonly calls: CommandInput[] = [];
	readonly states = new Map<string, FakePluginState>();
	readonly hermesScanPolicies = new Map<string, boolean>();
	failLiveHermesScanPolicy = false;
	failLiveEnableVersion: string | null = null;
	openClawMcpServersOverride: Array<{
		name: string;
		hasStdioTransport: boolean;
		unsupported?: boolean;
	}> | null = null;
	openClawFaultPackageName = "acme.tools";
	readonly liveHome: string;

	constructor() {
		runtimeTestHomeSequence += 1;
		this.liveHome = join(runtimeTestRoot, `home-${runtimeTestHomeSequence}`);
		mkdirSync(this.liveHome, { recursive: true });
	}

	private runtime(input: CommandInput): HostedAgentPluginRuntime {
		return basename(input.command).includes("openclaw") ? "openclaw" : "hermes";
	}

	private key(input: CommandInput, name: string): string {
		return `${input.home}\0${this.runtime(input)}\0${name}`;
	}

	private installPath(home: string, runtime: HostedAgentPluginRuntime, nativeId: string): string {
		return join(
			home,
			runtime === "openclaw" ? ".openclaw" : ".hermes",
			runtime === "openclaw" ? "extensions" : "plugins",
			nativeId,
		);
	}

	seed(
		runtime: HostedAgentPluginRuntime,
		plugin: FakePluginState,
		prepared?: PreparedHostedAgentPlugin,
	): void {
		this.states.set(`${this.liveHome}\0${runtime}\0${plugin.name}`, plugin);
		const target = this.installPath(this.liveHome, runtime, plugin.nativeId);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		if (prepared) {
			for (const file of prepared.tree) {
				const path = join(target, ...file.path.split("/"));
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, file.bytes, { mode: file.mode & 0o777 });
			}
		} else {
			writeFileSync(
				join(target, "plugin.json"),
				JSON.stringify({
					$schema: AGENT_PLUGINS_SCHEMA_1_0_0,
					name: plugin.name,
					version: plugin.version,
				}),
			);
		}
	}

	get(runtime: HostedAgentPluginRuntime, name: string): FakePluginState | undefined {
		return this.states.get(`${this.liveHome}\0${runtime}\0${name}`);
	}

	setHermesScanPolicy(value: boolean): void {
		this.hermesScanPolicies.set(this.liveHome, value);
		const stateRoot = join(this.liveHome, ".hermes");
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(join(stateRoot, "config.yaml"), `plugins:\n  scan_on_install: ${value}\n`);
	}

	hermesScanPolicy(): boolean | "unset" {
		return this.hermesScanPolicies.get(this.liveHome) ?? "unset";
	}

	private pluginFromSource(path: string): {
		name: string;
		version: string;
		mcpServerNames: string[];
	} {
		const parsed: unknown = JSON.parse(readFileSync(join(path, "plugin.json"), "utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("name" in parsed) ||
			typeof parsed.name !== "string" ||
			!("version" in parsed) ||
			typeof parsed.version !== "string"
		) {
			throw new Error("invalid fake plugin manifest");
		}
		let mcpServerNames: string[] = [];
		try {
			const mcp: unknown = JSON.parse(readFileSync(join(path, "mcp.json"), "utf8"));
			if (typeof mcp === "object" && mcp !== null && "mcpServers" in mcp) {
				const servers = mcp.mcpServers;
				if (typeof servers === "object" && servers !== null) {
					mcpServerNames = Object.keys(servers).sort();
				}
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		return { name: parsed.name, version: parsed.version, mcpServerNames };
	}

	run(input: CommandInput) {
		this.calls.push(input);
		if (input.command === "git") return { status: 0, stdout: "", stderr: "" };
		const runtime = this.runtime(input);
		const expectedStateRoot = join(input.home, runtime === "openclaw" ? ".openclaw" : ".hermes");
		const actualStateRoot =
			runtime === "openclaw"
				? input.environmentOverrides.OPENCLAW_STATE_DIR
				: input.environmentOverrides.HERMES_HOME;
		if (actualStateRoot !== expectedStateRoot) {
			return { status: 70, stdout: "", stderr: "unsafe state root" };
		}
		const args = input.args;
		if (
			runtime === "hermes" &&
			args.join("\0") ===
				["config", "set", "--force", "plugins.scan_on_install", "false"].join("\0")
		) {
			if (input.home === this.liveHome && this.failLiveHermesScanPolicy) {
				return { status: 44, stdout: "", stderr: "scan policy failure" };
			}
			this.hermesScanPolicies.set(input.home, false);
			mkdirSync(expectedStateRoot, { recursive: true });
			writeFileSync(join(expectedStateRoot, "config.yaml"), "plugins:\n  scan_on_install: false\n");
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] !== "plugins") return { status: 2, stdout: "", stderr: "" };
		if (args[1] === "list" && args[2] === "--json") {
			const plugins = [...this.states.entries()]
				.filter(([key]) => key.startsWith(`${input.home}\0${runtime}\0`))
				.map(([, plugin]) => plugin);
			if (runtime === "hermes") {
				return {
					status: 0,
					stdout: JSON.stringify(
						plugins.map((plugin) => ({
							name: plugin.name,
							status: plugin.enabled ? "enabled" : "disabled",
							version: plugin.version,
							description: "",
							source: plugin.compatible ? "git" : "bundled",
						})),
					),
					stderr: "",
				};
			}
			return {
				status: 0,
				stdout: JSON.stringify({
					plugins: plugins.map((plugin) => ({
						id: plugin.nativeId,
						name: plugin.name,
						version: plugin.version,
						enabled: plugin.enabled,
						status: plugin.enabled ? "loaded" : "disabled",
						format: plugin.compatible ? "bundle" : "openclaw",
						bundleFormat: plugin.compatible ? "agent" : undefined,
					})),
				}),
				stderr: "",
			};
		}
		if (runtime === "openclaw" && args[1] === "inspect") {
			const plugin = [...this.states.entries()]
				.filter(([key]) => key.startsWith(`${input.home}\0openclaw\0`))
				.map(([, value]) => value)
				.find((value) => value.nativeId === args[2]);
			if (!plugin) return { status: 1, stdout: "", stderr: "" };
			const applyPackageFaults = plugin.name === this.openClawFaultPackageName;
			return {
				status: 0,
				stdout: JSON.stringify({
					plugin: {
						id: plugin.nativeId,
						name: plugin.name,
						source: join(input.home, ".openclaw", "extensions", plugin.nativeId),
						origin: "global",
						status: plugin.enabled ? "loaded" : "disabled",
						version: plugin.version,
						enabled: plugin.enabled,
						format: plugin.compatible ? "bundle" : "openclaw",
						bundleFormat: plugin.compatible ? "agent" : undefined,
					},
					install: {
						source: "path",
						version: plugin.version,
						installPath: this.installPath(input.home, runtime, plugin.nativeId),
					},
					mcpServers:
						(applyPackageFaults ? this.openClawMcpServersOverride : null) ??
						(plugin.mcpServerNames ?? []).map((name) => ({
							name,
							hasStdioTransport: true,
						})),
					diagnostics: [],
				}),
				stderr: "",
			};
		}
		if (args[1] === "install") {
			const source = runtime === "hermes" ? fileURLToPath(args[2] ?? "") : (args[2] ?? "");
			const manifest = this.pluginFromSource(source);
			const nativeId = runtime === "openclaw" ? manifest.name.replaceAll(".", "-") : manifest.name;
			const target = this.installPath(input.home, runtime, nativeId);
			rmSync(target, { recursive: true, force: true });
			mkdirSync(join(target, ".."), { recursive: true });
			cpSync(source, target, { recursive: true });
			for (const [key, plugin] of this.states) {
				if (key.startsWith(`${input.home}\0${runtime}\0`) && plugin.nativeId === nativeId) {
					this.states.delete(key);
				}
			}
			this.states.set(this.key(input, manifest.name), {
				name: manifest.name,
				nativeId,
				version: manifest.version,
				enabled: false,
				compatible: true,
				mcpServerNames: manifest.mcpServerNames,
			});
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[1] === "enable" || args[1] === "disable") {
			const plugin = [...this.states.entries()]
				.filter(([key]) => key.startsWith(`${input.home}\0${runtime}\0`))
				.map(([, value]) => value)
				.find((value) => value.nativeId === args[2] || value.name === args[2]);
			if (!plugin) return { status: 1, stdout: "", stderr: "" };
			if (
				args[1] === "enable" &&
				input.home === this.liveHome &&
				plugin.version === this.failLiveEnableVersion
			) {
				this.failLiveEnableVersion = null;
				return { status: 41, stdout: "", stderr: "redacted failure" };
			}
			plugin.enabled = args[1] === "enable";
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[1] === "uninstall" || args[1] === "remove") {
			for (const [key, plugin] of this.states) {
				if (
					key.startsWith(`${input.home}\0${runtime}\0`) &&
					(plugin.nativeId === args[2] || plugin.name === args[2])
				) {
					this.states.delete(key);
					rmSync(this.installPath(input.home, runtime, plugin.nativeId), {
						recursive: true,
						force: true,
					});
				}
			}
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 2, stdout: "", stderr: "" };
	}

	liveMutations(): CommandInput[] {
		return this.calls.filter(
			(call) =>
				call.home === this.liveHome &&
				call.command !== "git" &&
				!["list", "inspect"].includes(call.args[1] ?? ""),
		);
	}
}

function plugin(
	name: string,
	version: string,
	ownershipIdentity: string,
	mcpServerNames: readonly string[] = [],
): PreparedHostedAgentPlugin {
	const manifest = Buffer.from(
		JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_1_0_0, name, version }),
	);
	const mcp =
		mcpServerNames.length === 0
			? null
			: Buffer.from(
					JSON.stringify({
						$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
						mcpServers: Object.fromEntries(
							mcpServerNames.map((serverName) => [serverName, { type: "stdio", command: "node" }]),
						),
					}),
				);
	const tree = [
		{ path: "plugin.json", mode: 0o100644 as const, bytes: manifest },
		...(mcp ? [{ path: "mcp.json", mode: 0o100644 as const, bytes: mcp }] : []),
	].sort((left, right) => left.path.localeCompare(right.path));
	const treeDigest = createHash("sha256");
	for (const file of tree) {
		const fileDigest = createHash("sha256").update(file.bytes).digest("hex");
		treeDigest.update(
			`${file.mode.toString(8)}\0${file.path}\0${file.bytes.byteLength}\0${fileDigest}\n`,
		);
	}
	return {
		name,
		installation: {
			installationId: `install_${ownershipIdentity.slice(0, 8)}`,
			version,
			agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
			source: {
				type: "github",
				url: "https://github.com/acme/agent-plugins",
				path: `plugins/${name}`,
				commit: ownershipIdentity.slice(0, 40),
			},
			contentDigest: `sha256-tree-v1:${treeDigest.digest("hex")}`,
			ownershipIdentity,
		},
		mcpServerNames: [...mcpServerNames].sort(),
		tree,
	};
}

function prepareTransaction(prepared: PreparedHostedAgentPlugins, runner: FakeNativeRunner) {
	return prepareHostedAgentPluginTransaction({
		prepared,
		home: runner.liveHome,
		commands,
		runner,
	});
}

function desiredState(
	runtime: HostedAgentPluginRuntime,
	desired: PreparedHostedAgentPlugin,
	previous?: { runtime: HostedAgentPluginRuntime; plugin: PreparedHostedAgentPlugin },
): PreparedHostedAgentPlugins {
	return {
		runtime,
		desired: new Map([[desired.name, desired]]),
		previous: previous
			? new Map([
					[
						previous.plugin.name,
						{
							runtime: previous.runtime,
							name: previous.plugin.name,
							installation: previous.plugin.installation,
							nativeId: previous.plugin.name.replaceAll(".", "-"),
						},
					],
				])
			: new Map(),
		transientCacheOwnerships: new Set(),
	};
}

const commands = { openclaw: "/runtime/openclaw", hermes: "/runtime/hermes" };

describe("Hosted Agent Plugin native reconciliation", () => {
	test("observes installed plugin bytes only through the repaired runtime-user identity", () => {
		if (process.geteuid?.() !== 0) return;
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "8".repeat(64));
		runner.seed(
			"openclaw",
			{
				name: desired.name,
				nativeId: "acme-tools",
				version: desired.installation.version,
				enabled: true,
				compatible: true,
			},
			desired,
		);
		const prepared = desiredState("openclaw", desired, {
			runtime: "openclaw",
			plugin: desired,
		});
		const stateRoot = join(runner.liveHome, ".openclaw");
		const installRoot = join(stateRoot, "extensions", "acme-tools");
		const runtimeUid = runtimeUserUid("nobody");
		const runtimeGid = runtimeUserGid("nobody");
		const previousRootMode = statSync(runtimeTestRoot).mode & 0o777;
		const previousRuntimeUser = process.env.CLAWDI_RUNTIME_USER;
		const previousRuntimeUid = process.env.CLAWDI_RUNTIME_UID;
		const previousRuntimeGid = process.env.CLAWDI_RUNTIME_GID;
		try {
			chmodSync(runtimeTestRoot, 0o755);
			for (const path of [runner.liveHome, stateRoot, join(stateRoot, "extensions")]) {
				chownSync(path, runtimeUid, runtimeGid);
			}
			chownSync(installRoot, 0, 0);
			chmodSync(installRoot, 0o700);
			process.env.CLAWDI_RUNTIME_USER = "nobody";
			process.env.CLAWDI_RUNTIME_UID = String(runtimeUid);
			process.env.CLAWDI_RUNTIME_GID = String(runtimeGid);

			expect(() =>
				prepareHostedAgentPluginTransaction({
					prepared,
					home: runner.liveHome,
					commands,
					runner,
				}),
			).toThrow();

			enforceRuntimeUserOwnership(runtimeUserExistingOwnership([stateRoot], { recursive: true }));
			expect(() =>
				prepareHostedAgentPluginTransaction({
					prepared,
					home: runner.liveHome,
					commands,
					runner,
				}),
			).not.toThrow();
			expect(statSync(installRoot).uid).toBe(runtimeUid);
		} finally {
			chmodSync(runtimeTestRoot, previousRootMode);
			if (previousRuntimeUser === undefined) delete process.env.CLAWDI_RUNTIME_USER;
			else process.env.CLAWDI_RUNTIME_USER = previousRuntimeUser;
			if (previousRuntimeUid === undefined) delete process.env.CLAWDI_RUNTIME_UID;
			else process.env.CLAWDI_RUNTIME_UID = previousRuntimeUid;
			if (previousRuntimeGid === undefined) delete process.env.CLAWDI_RUNTIME_GID;
			else process.env.CLAWDI_RUNTIME_GID = previousRuntimeGid;
		}
	});

	test("uses OpenClaw native lifecycle and repeats as a live no-op", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "a".repeat(64));
		const prepared = desiredState("openclaw", desired);
		const first = prepareHostedAgentPluginTransaction({
			prepared,
			home: runner.liveHome,
			commands,
			runner,
		});
		const receipt = first.apply();
		expect(runner.get("openclaw", desired.name)).toMatchObject({
			version: desired.installation.version,
			enabled: true,
		});
		expect(receipt?.installations).toEqual({
			"acme.tools": {
				...desired.installation,
				nativeId: "acme-tools",
			},
		});
		const liveMutations = runner.liveMutations().length;
		const repeat = prepareTransaction(
			desiredState("openclaw", desired, { runtime: "openclaw", plugin: desired }),
			runner,
		);
		repeat.apply();
		expect(runner.liveMutations()).toHaveLength(liveMutations);
	});

	test("validates runtime-reported package support after live installation", () => {
		const desired = plugin("acme.tools", "1.2.3", "f".repeat(64), ["alpha", "zeta"]);
		const runner = new FakeNativeRunner();
		runner.openClawMcpServersOverride = [
			{ name: "alpha", hasStdioTransport: true },
			{ name: "zeta", hasStdioTransport: false, unsupported: true },
		];
		const transaction = prepareTransaction(desiredState("openclaw", desired), runner);

		expect(() => transaction.apply()).toThrow(
			"native Agent Plugin installed an unexpected identity or package",
		);
		expect(runner.liveMutations().map((call) => call.args[1])).toEqual(["install"]);
	});

	test("persistently disables an unset Hermes install scan before managed installation", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "b".repeat(64));
		const transaction = prepareTransaction(desiredState("hermes", desired), runner);
		expect(transaction.snapshotTargets).toContain(join(runner.liveHome, ".hermes", "config.yaml"));

		transaction.apply();

		const installIndex = runner.calls.findIndex(
			(call) => call.home === runner.liveHome && call.args[1] === "install",
		);
		const scanPolicyIndex = runner.calls.findIndex(
			(call) => call.home === runner.liveHome && call.args[0] === "config",
		);
		const install = runner.calls[installIndex];
		const scanPolicy = runner.calls[scanPolicyIndex];
		expect(scanPolicy?.args).toEqual([
			"config",
			"set",
			"--force",
			"plugins.scan_on_install",
			"false",
		]);
		expect(scanPolicyIndex).toBeGreaterThanOrEqual(0);
		expect(scanPolicyIndex).toBeLessThan(installIndex);
		expect(scanPolicy?.home).toBe(runner.liveHome);
		expect(scanPolicy?.cwd).toBe(runner.liveHome);
		expect(scanPolicy?.environmentOverrides).toEqual(install?.environmentOverrides);
		expect(install?.args[2]?.startsWith("file://")).toBe(true);
		expect(install?.args.join(" ")).not.toContain("github.com");
		expect(readFileSync(join(runner.liveHome, ".hermes", "config.yaml"), "utf-8")).toContain(
			"scan_on_install: false",
		);
		expect(runner.hermesScanPolicy()).toBe(false);
		expect(install?.environmentOverrides).toEqual({
			OPENCLAW_HOME: undefined,
			OPENCLAW_PROFILE: undefined,
			OPENCLAW_STATE_DIR: undefined,
			OPENCLAW_CONFIG_PATH: undefined,
			OPENCLAW_INCLUDE_ROOTS: undefined,
			OPENCLAW_OAUTH_DIR: undefined,
			OPENCLAW_AGENT_ID: undefined,
			HERMES_HOME: join(runner.liveHome, ".hermes"),
			HERMES_PROFILE: undefined,
			HERMES_CONFIG: undefined,
			HERMES_ENV: undefined,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
			GIT_ATTR_NOSYSTEM: "1",
			GIT_COMMON_DIR: undefined,
			GIT_CONFIG_COUNT: undefined,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_PARAMETERS: undefined,
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_DIR: undefined,
			GIT_EXEC_PATH: undefined,
			GIT_INDEX_FILE: undefined,
			GIT_NAMESPACE: undefined,
			GIT_OBJECT_DIRECTORY: undefined,
			GIT_REPLACE_REF_BASE: undefined,
			GIT_SHALLOW_FILE: undefined,
			GIT_TEMPLATE_DIR: undefined,
			GIT_WORK_TREE: undefined,
		});
		expect(
			runner.calls.some(
				(call) =>
					call.command === "git" && call.args.includes("add") && call.args.includes("--force"),
			),
		).toBe(true);
		expect(runner.get("hermes", desired.name)?.enabled).toBe(true);

		const failingRunner = new FakeNativeRunner();
		const failingTransaction = prepareTransaction(desiredState("hermes", desired), failingRunner);
		failingRunner.failLiveHermesScanPolicy = true;
		expect(() => failingTransaction.apply()).toThrow(
			"Hermes Agent Plugin scan policy update failed: scan policy failure",
		);
		expect(
			failingRunner.calls.some(
				(call) => call.home === failingRunner.liveHome && call.args[1] === "install",
			),
		).toBe(false);
	});

	test("does not rewrite an already-disabled Hermes install scan", () => {
		const runner = new FakeNativeRunner();
		runner.setHermesScanPolicy(false);
		const desired = plugin("acme.tools", "1.2.3", "9".repeat(64));
		const transaction = prepareTransaction(desiredState("hermes", desired), runner);

		transaction.apply();

		const liveConfigCalls = runner.calls.filter(
			(call) => call.home === runner.liveHome && call.args[0] === "config",
		);
		expect(liveConfigCalls).toEqual([]);
		expect(runner.hermesScanPolicy()).toBe(false);
		expect(runner.get("hermes", desired.name)?.enabled).toBe(true);
	});

	test("refuses an unmanaged same-name native plugin before live mutation", () => {
		const runner = new FakeNativeRunner();
		const prepared = desiredState("openclaw", plugin("acme.tools", "1.2.3", "d".repeat(64)));
		runner.seed("openclaw", {
			name: "acme.tools",
			nativeId: "acme-tools",
			version: "1.2.3",
			enabled: true,
			compatible: true,
		});
		expect(() =>
			prepareHostedAgentPluginTransaction({
				prepared,
				home: runner.liveHome,
				commands,
				runner,
			}),
		).toThrow("unmanaged");
		expect(runner.liveMutations()).toEqual([]);
	});

	test("refuses a same-name plugin that appears after ownership planning", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "1".repeat(64));
		const transaction = prepareTransaction(desiredState("openclaw", desired), runner);
		runner.seed("openclaw", {
			name: desired.name,
			nativeId: "acme-tools",
			version: "9.9.9",
			enabled: true,
			compatible: true,
		});

		expect(() => transaction.apply()).toThrow("changed after ownership was verified");
		expect(runner.liveMutations()).toEqual([]);
		expect(runner.get("openclaw", desired.name)?.version).toBe("9.9.9");
	});

	test("refuses same-version installed byte drift under an ownership receipt", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "4".repeat(64));
		runner.seed(
			"openclaw",
			{
				name: desired.name,
				nativeId: "acme-tools",
				version: desired.installation.version,
				enabled: true,
				compatible: true,
			},
			desired,
		);
		writeFileSync(
			join(runner.liveHome, ".openclaw", "extensions", "acme-tools", "drift.txt"),
			"unmanaged drift",
		);
		const prepared = desiredState("openclaw", desired, {
			runtime: "openclaw",
			plugin: desired,
		});

		expect(() => prepareTransaction(prepared, runner)).toThrow("ownership receipt");
		expect(runner.liveMutations()).toEqual([]);
	});

	test("rejects an unmanaged OpenClaw plugin occupying the installed native id", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "5".repeat(64));
		const prepared = desiredState("openclaw", desired);
		runner.seed("openclaw", {
			name: "acme-tools",
			nativeId: "acme-tools",
			version: "9.0.0",
			enabled: true,
			compatible: true,
		});

		const transaction = prepareHostedAgentPluginTransaction({
			prepared,
			home: runner.liveHome,
			commands,
			runner,
		});

		expect(() => transaction.apply()).toThrow("unmanaged native Agent Plugin target");
		expect(runner.liveMutations().map((call) => call.args[1])).toEqual(["install"]);
	});

	test("rejects an unobserved filesystem target after resolving the installed native id", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "a".repeat(64));
		const prepared = desiredState("openclaw", desired);
		const target = join(runner.liveHome, ".openclaw", "extensions", "acme-tools");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "unmanaged.txt"), "unmanaged");

		const transaction = prepareHostedAgentPluginTransaction({
			prepared,
			home: runner.liveHome,
			commands,
			runner,
		});
		expect(transaction.snapshotTargets).toContain(join(runner.liveHome, ".openclaw", "extensions"));
		expect(() => transaction.apply()).toThrow("unmanaged native Agent Plugin target");
	});

	test("rejects desired packages that resolve to one native id", () => {
		const runner = new FakeNativeRunner();
		const dotted = plugin("acme.tools", "1.0.0", "6".repeat(64));
		const dashed = plugin("acme-tools", "1.0.0", "7".repeat(64));
		const prepared: PreparedHostedAgentPlugins = {
			runtime: "openclaw",
			desired: new Map([
				[dotted.name, dotted],
				[dashed.name, dashed],
			]),
			previous: new Map(),
			transientCacheOwnerships: new Set(),
		};

		const transaction = prepareTransaction(prepared, runner);
		expect(() => transaction.apply()).toThrow("same native identity");
	});
});
