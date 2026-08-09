import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	HostedAgentPluginReceipt,
	HostedAgentPluginRuntime,
	PreparedHostedAgentPlugin,
	PreparedHostedAgentPlugins,
} from "./hosted-agent-plugin-package";
import {
	type HostedAgentPluginCommandRunner,
	prepareHostedAgentPluginTransaction,
	proveHostedAgentPluginCapabilities,
} from "./hosted-agent-plugin-runtime";
import { AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR } from "./manifest-contract";
import { AGENT_PLUGINS_SCHEMA_1_0_0 } from "./manifest-resources";

type CommandInput = Parameters<HostedAgentPluginCommandRunner["run"]>[0];

interface FakePluginState {
	name: string;
	nativeId: string;
	version: string;
	enabled: boolean;
	compatible: boolean;
}

class FakeNativeRunner implements HostedAgentPluginCommandRunner {
	readonly calls: CommandInput[] = [];
	readonly states = new Map<string, FakePluginState>();
	availableResult = true;
	failLiveEnableVersion: string | null = null;
	liveHome = "/hosted/home";

	available(): boolean {
		return this.availableResult;
	}

	private runtime(input: CommandInput): HostedAgentPluginRuntime {
		return basename(input.command).includes("openclaw") ? "openclaw" : "hermes";
	}

	private key(input: CommandInput, name: string): string {
		return `${input.home}\0${this.runtime(input)}\0${name}`;
	}

	seed(runtime: HostedAgentPluginRuntime, plugin: FakePluginState): void {
		this.states.set(`${this.liveHome}\0${runtime}\0${plugin.name}`, plugin);
	}

	get(runtime: HostedAgentPluginRuntime, name: string): FakePluginState | undefined {
		return this.states.get(`${this.liveHome}\0${runtime}\0${name}`);
	}

	private pluginFromSource(path: string): { name: string; version: string } {
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
		return { name: parsed.name, version: parsed.version };
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
					install: { source: "path", version: plugin.version },
				}),
				stderr: "",
			};
		}
		if (args[1] === "install") {
			const source = runtime === "hermes" ? fileURLToPath(args[2] ?? "") : (args[2] ?? "");
			const manifest = this.pluginFromSource(source);
			this.states.set(this.key(input, manifest.name), {
				name: manifest.name,
				nativeId: runtime === "openclaw" ? manifest.name.replaceAll(".", "-") : manifest.name,
				version: manifest.version,
				enabled: false,
				compatible: true,
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
): PreparedHostedAgentPlugin {
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
			contentDigest: `sha256-tree-v1:${ownershipIdentity}`,
			ownershipIdentity,
		},
		tree: [
			{
				path: "plugin.json",
				mode: 0o100644,
				bytes: Buffer.from(JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_1_0_0, name, version })),
			},
		],
	};
}

function desiredState(
	runtime: HostedAgentPluginRuntime,
	desired: PreparedHostedAgentPlugin,
	previous?: { runtime: HostedAgentPluginRuntime; plugin: PreparedHostedAgentPlugin },
): PreparedHostedAgentPlugins {
	const previousReceipt: HostedAgentPluginReceipt | null = previous
		? {
				schemaVersion: "clawdi.hostedAgentPluginReceipts.v1",
				runtime: previous.runtime,
				installations: { [previous.plugin.name]: previous.plugin.installation },
			}
		: null;
	return {
		runtime,
		desired: new Map([[desired.name, desired]]),
		previousReceipt,
		rollback: previous ? new Map([[previous.plugin.name, previous.plugin]]) : new Map(),
	};
}

const commands = { openclaw: "/runtime/openclaw", hermes: "/runtime/hermes" };

describe("Hosted Agent Plugin native reconciliation", () => {
	test("uses OpenClaw native lifecycle and repeats as a live no-op", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "a".repeat(64));
		const prepared = desiredState("openclaw", desired);
		const capabilityProof = proveHostedAgentPluginCapabilities({
			prepared,
			commands,
			runner,
		});
		const isolatedCalls = runner.calls.filter((call) => call.home !== runner.liveHome).length;
		const first = prepareHostedAgentPluginTransaction({
			prepared,
			home: runner.liveHome,
			commands,
			capabilityProof,
			runner,
		});
		expect(runner.calls.filter((call) => call.home !== runner.liveHome)).toHaveLength(
			isolatedCalls,
		);
		const probe = runner.calls.find(
			(call) => call.home !== runner.liveHome && call.command === commands.openclaw,
		);
		if (!probe) throw new Error("missing isolated OpenClaw capability probe");
		expect(probe.environmentOverrides).toEqual({
			OPENCLAW_HOME: undefined,
			OPENCLAW_PROFILE: undefined,
			OPENCLAW_STATE_DIR: join(probe.home, ".openclaw"),
			OPENCLAW_CONFIG_PATH: undefined,
			OPENCLAW_INCLUDE_ROOTS: undefined,
			OPENCLAW_OAUTH_DIR: undefined,
			OPENCLAW_AGENT_ID: undefined,
			HERMES_HOME: undefined,
			HERMES_PROFILE: undefined,
			HERMES_CONFIG: undefined,
			HERMES_ENV: undefined,
		});
		first.apply();
		expect(runner.get("openclaw", desired.name)).toMatchObject({
			version: desired.installation.version,
			enabled: true,
		});
		const receipt = first.nextReceipt;
		if (!receipt) throw new Error("missing receipt fixture");
		const liveMutations = runner.liveMutations().length;
		const repeat = prepareHostedAgentPluginTransaction({
			prepared: {
				runtime: "openclaw",
				desired: new Map([[desired.name, desired]]),
				previousReceipt: receipt,
				rollback: new Map([[desired.name, desired]]),
			},
			home: runner.liveHome,
			commands,
			runner,
		});
		repeat.apply();
		expect(runner.liveMutations()).toHaveLength(liveMutations);
	});

	test("installs the Hermes stdio-capable package from a local file Git transport", () => {
		const runner = new FakeNativeRunner();
		const desired = plugin("acme.tools", "1.2.3", "b".repeat(64));
		const transaction = prepareHostedAgentPluginTransaction({
			prepared: desiredState("hermes", desired),
			home: runner.liveHome,
			commands,
			runner,
		});
		transaction.apply();
		const install = runner.calls.find(
			(call) => call.home === runner.liveHome && call.args[1] === "install",
		);
		expect(install?.args[2]?.startsWith("file://")).toBe(true);
		expect(install?.args.join(" ")).not.toContain("github.com");
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
	});

	test("fails the capability gate before any command when the runtime is unsupported", () => {
		const runner = new FakeNativeRunner();
		runner.availableResult = false;
		expect(() =>
			prepareHostedAgentPluginTransaction({
				prepared: desiredState("openclaw", plugin("acme.tools", "1.2.3", "c".repeat(64))),
				home: runner.liveHome,
				commands,
				runner,
			}),
		).toThrow(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
		expect(runner.calls).toEqual([]);
	});

	test("refuses an unmanaged same-name native plugin before live mutation", () => {
		const runner = new FakeNativeRunner();
		runner.seed("openclaw", {
			name: "acme.tools",
			nativeId: "acme-tools",
			version: "1.2.3",
			enabled: true,
			compatible: true,
		});
		expect(() =>
			prepareHostedAgentPluginTransaction({
				prepared: desiredState("openclaw", plugin("acme.tools", "1.2.3", "d".repeat(64))),
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
		const transaction = prepareHostedAgentPluginTransaction({
			prepared: desiredState("openclaw", desired),
			home: runner.liveHome,
			commands,
			runner,
		});
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

	test("restores the previous native package and leaves authority uncommitted after replacement failure", () => {
		const runner = new FakeNativeRunner();
		const previous = plugin("acme.tools", "1.2.3", "e".repeat(64));
		const desired = plugin("acme.tools", "2.0.0", "f".repeat(64));
		runner.seed("openclaw", {
			name: previous.name,
			nativeId: "acme-tools",
			version: previous.installation.version,
			enabled: true,
			compatible: true,
		});
		runner.failLiveEnableVersion = desired.installation.version;
		const transaction = prepareHostedAgentPluginTransaction({
			prepared: desiredState("openclaw", desired, { runtime: "openclaw", plugin: previous }),
			home: runner.liveHome,
			commands,
			runner,
		});
		let authorityCommitted = false;
		try {
			transaction.apply();
			authorityCommitted = true;
		} catch {
			expect(transaction.rollback()).toEqual([]);
		}
		expect(authorityCommitted).toBe(false);
		expect(runner.get("openclaw", previous.name)).toMatchObject({
			version: previous.installation.version,
			enabled: true,
		});
	});
});
