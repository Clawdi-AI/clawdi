import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	type HostedAgentPluginReceipt,
	type HostedAgentPluginReceiptInstallation,
	type HostedAgentPluginRuntime,
	type PreparedHostedAgentPlugin,
	type PreparedHostedAgentPlugins,
	withPreparedAgentPluginDirectory,
} from "./hosted-agent-plugin-package";
import { AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR } from "./manifest-contract";
import {
	openClawPluginInspectSchema,
	openClawPluginListSchema,
} from "./openclaw-plugin-observation";
import {
	commandResolvable,
	makeRuntimeUserOwned,
	spawnRuntimeUserCommand,
} from "./runtime-user-command";

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const capabilityProofMarker = Symbol("HostedAgentPluginCapabilityProof");
const isolatedGitEnvironment: Readonly<Record<string, string | undefined>> = {
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
	GIT_ATTR_NOSYSTEM: "1",
	GIT_COMMON_DIR: undefined,
	GIT_CONFIG_COUNT: undefined,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_PARAMETERS: undefined,
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_DIR: undefined,
	GIT_NAMESPACE: undefined,
	GIT_EXEC_PATH: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_REPLACE_REF_BASE: undefined,
	GIT_SHALLOW_FILE: undefined,
	GIT_TEMPLATE_DIR: undefined,
	GIT_WORK_TREE: undefined,
};

export type HostedAgentPluginCommands = Readonly<Record<HostedAgentPluginRuntime, string>>;

export function hostedAgentPluginCommands(home: string): HostedAgentPluginCommands {
	return {
		openclaw: join(home, ".openclaw", "bin", "openclaw"),
		hermes: join(home, ".local", "bin", "hermes"),
	};
}

interface AgentPluginCommandInput {
	command: string;
	args: string[];
	home: string;
	cwd: string;
	environmentOverrides: Readonly<Record<string, string | undefined>>;
}

interface AgentPluginCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface HostedAgentPluginCommandRunner {
	available(command: string): boolean;
	run(input: AgentPluginCommandInput): AgentPluginCommandResult;
}

export interface HostedAgentPluginCapabilityProof {
	readonly [capabilityProofMarker]: true;
	readonly commands: HostedAgentPluginCommands;
	readonly runner: HostedAgentPluginCommandRunner;
	readonly runtimes: ReadonlySet<HostedAgentPluginRuntime>;
}

const defaultCommandRunner: HostedAgentPluginCommandRunner = {
	available: commandResolvable,
	run(input) {
		const result = spawnRuntimeUserCommand(input.command, input.args, input.home, input.cwd, {
			environmentOverrides: input.environmentOverrides,
			timeoutMs: COMMAND_TIMEOUT_MS,
			maxBufferBytes: COMMAND_MAX_BUFFER_BYTES,
		});
		return {
			status: result.status,
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
		};
	},
};

// `hermes plugins list --json` emits this array at
// https://github.com/NousResearch/hermes-agent/blob/255e6987b6150341a732d227a3e4d39d665752ca/hermes_cli/plugins_cmd.py
const hermesPluginListSchema = z.array(
	z
		.object({
			name: z.string().min(1),
			status: z.enum(["enabled", "disabled", "not enabled"]),
			version: z.string(),
			source: z.string().min(1),
		})
		.passthrough(),
);

interface NativePluginObservation {
	name: string;
	nativeId: string;
	version: string;
	enabled: boolean;
	compatible: boolean;
}

interface NativeAgentPluginDriver {
	runtime: HostedAgentPluginRuntime;
	observe(name: string): NativePluginObservation | null;
	install(prepared: PreparedHostedAgentPlugin): NativePluginObservation;
	setEnabled(observation: NativePluginObservation, enabled: boolean): void;
	remove(name: string): void;
}

function isolatedNativeEnvironment(
	runtime: HostedAgentPluginRuntime,
	home: string,
): Readonly<Record<string, string | undefined>> {
	return {
		OPENCLAW_HOME: undefined,
		OPENCLAW_PROFILE: undefined,
		OPENCLAW_STATE_DIR: runtime === "openclaw" ? join(home, ".openclaw") : undefined,
		OPENCLAW_CONFIG_PATH: undefined,
		OPENCLAW_INCLUDE_ROOTS: undefined,
		OPENCLAW_OAUTH_DIR: undefined,
		OPENCLAW_AGENT_ID: undefined,
		HERMES_HOME: runtime === "hermes" ? join(home, ".hermes") : undefined,
		HERMES_PROFILE: undefined,
		HERMES_CONFIG: undefined,
		HERMES_ENV: undefined,
		...(runtime === "hermes" ? isolatedGitEnvironment : {}),
	};
}

function parseJson<T>(result: AgentPluginCommandResult, schema: z.ZodType<T>): T {
	if (result.status !== 0) throw new Error("native Agent Plugin command failed");
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		return schema.parse(parsed);
	} catch {
		throw new Error("native Agent Plugin command returned malformed JSON");
	}
}

function runNative(
	runner: HostedAgentPluginCommandRunner,
	input: Omit<AgentPluginCommandInput, "environmentOverrides"> & {
		runtime: HostedAgentPluginRuntime;
	},
): AgentPluginCommandResult {
	return runner.run({
		command: input.command,
		args: input.args,
		home: input.home,
		cwd: input.cwd,
		environmentOverrides: isolatedNativeEnvironment(input.runtime, input.home),
	});
}

function createOpenClawDriver(input: {
	command: string;
	home: string;
	runner: HostedAgentPluginCommandRunner;
}): NativeAgentPluginDriver {
	const run = (args: string[]) =>
		runNative(input.runner, {
			runtime: "openclaw",
			command: input.command,
			args,
			home: input.home,
			cwd: input.home,
		});
	const observe = (name: string): NativePluginObservation | null => {
		const list = parseJson(run(["plugins", "list", "--json"]), openClawPluginListSchema);
		const matches = list.plugins.filter((plugin) => plugin.name === name);
		if (matches.length === 0) return null;
		if (matches.length !== 1) throw new Error("native Agent Plugin identity is ambiguous");
		const listed = matches[0];
		const inspect = parseJson(
			run(["plugins", "inspect", listed.id, "--json"]),
			openClawPluginInspectSchema,
		);
		const version =
			inspect.plugin.version ?? inspect.install.resolvedVersion ?? inspect.install.version ?? "";
		return {
			name,
			nativeId: inspect.plugin.id,
			version,
			enabled: inspect.plugin.enabled && inspect.plugin.status === "loaded",
			compatible:
				inspect.plugin.name === name &&
				inspect.plugin.format === "bundle" &&
				inspect.plugin.bundleFormat === "agent" &&
				inspect.install.source === "path",
		};
	};
	return {
		runtime: "openclaw",
		observe,
		install(prepared) {
			withPreparedAgentPluginDirectory(prepared, (sourceDir) => {
				const result = run(["plugins", "install", sourceDir, "--force"]);
				if (result.status !== 0) throw new Error("OpenClaw native Agent Plugin install failed");
			});
			const installed = observe(prepared.name);
			if (!installed) throw new Error("OpenClaw did not report the installed Agent Plugin");
			return installed;
		},
		setEnabled(observation, enabled) {
			const result = run(["plugins", enabled ? "enable" : "disable", observation.nativeId]);
			if (result.status !== 0) throw new Error("OpenClaw native Agent Plugin state change failed");
		},
		remove(name) {
			const current = observe(name);
			if (!current) return;
			if (!current.compatible) throw new Error("refusing to remove an unmanaged OpenClaw plugin");
			if (current.enabled) this.setEnabled(current, false);
			const result = run(["plugins", "uninstall", current.nativeId, "--force"]);
			if (result.status !== 0) throw new Error("OpenClaw native Agent Plugin uninstall failed");
		},
	};
}

function initializeLocalGitTransport(
	runner: HostedAgentPluginCommandRunner,
	runtime: HostedAgentPluginRuntime,
	home: string,
	sourceDir: string,
): void {
	const gitEnvironment = {
		...isolatedNativeEnvironment(runtime, home),
		...isolatedGitEnvironment,
		GIT_AUTHOR_NAME: "Clawdi Runtime",
		GIT_AUTHOR_EMAIL: "runtime@localhost",
		GIT_COMMITTER_NAME: "Clawdi Runtime",
		GIT_COMMITTER_EMAIL: "runtime@localhost",
	};
	for (const args of [
		["init", "--quiet", "--initial-branch=clawdi", sourceDir],
		["-C", sourceDir, "add", "--all", "--force"],
		["-C", sourceDir, "commit", "--quiet", "-m", "Clawdi verified Agent Plugin"],
	]) {
		const result = runner.run({
			command: "git",
			args,
			home,
			cwd: sourceDir,
			environmentOverrides: gitEnvironment,
		});
		if (result.status !== 0) throw new Error("Hermes local Agent Plugin transport failed");
	}
}

function createHermesDriver(input: {
	command: string;
	home: string;
	runner: HostedAgentPluginCommandRunner;
}): NativeAgentPluginDriver {
	const run = (args: string[]) =>
		runNative(input.runner, {
			runtime: "hermes",
			command: input.command,
			args,
			home: input.home,
			cwd: input.home,
		});
	const observe = (name: string): NativePluginObservation | null => {
		const list = parseJson(run(["plugins", "list", "--json"]), hermesPluginListSchema);
		const matches = list.filter((plugin) => plugin.name === name);
		if (matches.length === 0) return null;
		if (matches.length !== 1) throw new Error("native Agent Plugin identity is ambiguous");
		const plugin = matches[0];
		return {
			name,
			nativeId: name,
			version: plugin.version,
			enabled: plugin.status === "enabled",
			compatible: plugin.source === "git",
		};
	};
	return {
		runtime: "hermes",
		observe,
		install(prepared) {
			withPreparedAgentPluginDirectory(prepared, (sourceDir) => {
				initializeLocalGitTransport(input.runner, "hermes", input.home, sourceDir);
				const result = run([
					"plugins",
					"install",
					pathToFileURL(sourceDir).href,
					"--force",
					"--no-enable",
				]);
				if (result.status !== 0) throw new Error("Hermes native Agent Plugin install failed");
			});
			const installed = observe(prepared.name);
			if (!installed) throw new Error("Hermes did not report the installed Agent Plugin");
			return installed;
		},
		setEnabled(observation, enabled) {
			const args = ["plugins", enabled ? "enable" : "disable", observation.nativeId];
			if (enabled) args.push("--no-allow-tool-override");
			const result = run(args);
			if (result.status !== 0) throw new Error("Hermes native Agent Plugin state change failed");
		},
		remove(name) {
			const current = observe(name);
			if (!current) return;
			if (!current.compatible) throw new Error("refusing to remove an unmanaged Hermes plugin");
			if (current.enabled) this.setEnabled(current, false);
			const result = run(["plugins", "remove", current.nativeId]);
			if (result.status !== 0) throw new Error("Hermes native Agent Plugin remove failed");
		},
	};
}

function createNativeDriver(input: {
	runtime: HostedAgentPluginRuntime;
	command: string;
	home: string;
	runner: HostedAgentPluginCommandRunner;
}): NativeAgentPluginDriver {
	return input.runtime === "openclaw" ? createOpenClawDriver(input) : createHermesDriver(input);
}

function observationMatches(
	observation: NativePluginObservation | null,
	installation: HostedAgentPluginReceiptInstallation,
): observation is NativePluginObservation {
	return Boolean(observation?.compatible && observation.version === installation.version);
}

function observationUnchanged(
	current: NativePluginObservation | null,
	previous: NativePluginObservation | null,
): boolean {
	if (!current || !previous) return current === previous;
	return (
		current.name === previous.name &&
		current.nativeId === previous.nativeId &&
		current.version === previous.version &&
		current.enabled === previous.enabled &&
		current.compatible === previous.compatible
	);
}

interface PlannedMutation {
	runtime: HostedAgentPluginRuntime;
	name: string;
	driver: NativeAgentPluginDriver;
	desired: PreparedHostedAgentPlugin | null;
	previous: PreparedHostedAgentPlugin | null;
	before: NativePluginObservation | null;
	action: "enable" | "install" | "replace" | "remove";
}

export interface HostedAgentPluginTransaction {
	readonly nextReceipt: HostedAgentPluginReceipt | null;
	apply(): void;
	rollback(): string[];
}

function probeNativeCapability(input: {
	runtime: HostedAgentPluginRuntime;
	command: string;
	prepared: PreparedHostedAgentPlugin;
	runner: HostedAgentPluginCommandRunner;
}): void {
	if (!input.command.startsWith("/") || !input.runner.available(input.command)) {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	}
	const root = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-probe-"));
	try {
		makeRuntimeUserOwned(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		makeRuntimeUserOwned(home);
		const driver = createNativeDriver({
			runtime: input.runtime,
			command: input.command,
			home,
			runner: input.runner,
		});
		const installed = driver.install(input.prepared);
		driver.setEnabled(installed, true);
		const enabled = driver.observe(input.prepared.name);
		if (!observationMatches(enabled, input.prepared.installation) || !enabled.enabled)
			throw new Error();
		driver.setEnabled(enabled, false);
		if (driver.observe(input.prepared.name)?.enabled !== false) throw new Error();
		driver.remove(input.prepared.name);
		if (driver.observe(input.prepared.name) !== null) throw new Error();
	} catch {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function capabilityProbePackages(
	prepared: PreparedHostedAgentPlugins,
): ReadonlyMap<HostedAgentPluginRuntime, PreparedHostedAgentPlugin> {
	const packages = new Map<HostedAgentPluginRuntime, PreparedHostedAgentPlugin>();
	const desiredProbe = prepared.desired.values().next().value;
	if (desiredProbe) packages.set(prepared.runtime, desiredProbe);
	const previousRuntime = prepared.previousReceipt?.runtime;
	const rollbackProbe = prepared.rollback.values().next().value;
	if (previousRuntime && rollbackProbe && !packages.has(previousRuntime)) {
		packages.set(previousRuntime, rollbackProbe);
	}
	return packages;
}

export function proveHostedAgentPluginCapabilities(input: {
	prepared: PreparedHostedAgentPlugins;
	commands: HostedAgentPluginCommands;
	runner?: HostedAgentPluginCommandRunner;
}): HostedAgentPluginCapabilityProof {
	const runner = input.runner ?? defaultCommandRunner;
	const runtimes = new Set<HostedAgentPluginRuntime>();
	for (const [runtime, prepared] of capabilityProbePackages(input.prepared)) {
		probeNativeCapability({ runtime, command: input.commands[runtime], prepared, runner });
		runtimes.add(runtime);
	}
	return {
		[capabilityProofMarker]: true,
		commands: input.commands,
		runner,
		runtimes,
	};
}

function desiredReceipt(prepared: PreparedHostedAgentPlugins): HostedAgentPluginReceipt | null {
	if (prepared.desired.size === 0) return null;
	return {
		schemaVersion: "clawdi.hostedAgentPluginReceipts.v1",
		runtime: prepared.runtime,
		installations: Object.fromEntries(
			[...prepared.desired].map(([name, plugin]) => [name, plugin.installation]),
		),
	};
}

export function prepareHostedAgentPluginTransaction(input: {
	prepared: PreparedHostedAgentPlugins;
	home: string;
	commands: HostedAgentPluginCommands;
	capabilityProof?: HostedAgentPluginCapabilityProof;
	runner?: HostedAgentPluginCommandRunner;
}): HostedAgentPluginTransaction {
	const runner = input.runner ?? defaultCommandRunner;
	const probePackages = capabilityProbePackages(input.prepared);
	const proof = input.capabilityProof;
	const hasMatchingProof =
		proof?.[capabilityProofMarker] === true &&
		proof?.runner === runner &&
		[...probePackages.keys()].every(
			(runtime) =>
				proof.runtimes.has(runtime) && proof.commands[runtime] === input.commands[runtime],
		);
	if (!hasMatchingProof) {
		for (const [runtime, prepared] of probePackages) {
			probeNativeCapability({ runtime, command: input.commands[runtime], prepared, runner });
		}
	}

	const drivers = new Map<HostedAgentPluginRuntime, NativeAgentPluginDriver>();
	const driverFor = (runtime: HostedAgentPluginRuntime): NativeAgentPluginDriver => {
		const existing = drivers.get(runtime);
		if (existing) return existing;
		const command = input.commands[runtime];
		if (!command.startsWith("/") || !runner.available(command)) {
			throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
		}
		const driver = createNativeDriver({ runtime, command, home: input.home, runner });
		drivers.set(runtime, driver);
		return driver;
	};
	const slots = new Map<
		string,
		{
			runtime: HostedAgentPluginRuntime;
			name: string;
			desired: PreparedHostedAgentPlugin | null;
			previous: PreparedHostedAgentPlugin | null;
		}
	>();
	if (input.prepared.previousReceipt) {
		for (const [name, previous] of input.prepared.rollback) {
			const runtime = input.prepared.previousReceipt.runtime;
			slots.set(`${runtime}\0${name}`, { runtime, name, desired: null, previous });
		}
	}
	for (const [name, desired] of input.prepared.desired) {
		const key = `${input.prepared.runtime}\0${name}`;
		const slot = slots.get(key);
		slots.set(key, {
			runtime: input.prepared.runtime,
			name,
			desired,
			previous: slot?.previous ?? null,
		});
	}

	const mutations: PlannedMutation[] = [];
	for (const slot of [...slots.values()].sort((left, right) =>
		`${left.runtime}\0${left.name}`.localeCompare(`${right.runtime}\0${right.name}`),
	)) {
		const driver = driverFor(slot.runtime);
		const before = driver.observe(slot.name);
		if (slot.previous) {
			if (before && !observationMatches(before, slot.previous.installation)) {
				throw new Error(
					"refusing to mutate an Agent Plugin that no longer matches its ownership receipt",
				);
			}
		} else if (before) {
			throw new Error("refusing to replace an unmanaged native Agent Plugin");
		}
		if (!slot.desired) {
			if (before) mutations.push({ ...slot, driver, before, action: "remove" });
			continue;
		}
		if (
			slot.previous?.installation.ownershipIdentity ===
				slot.desired.installation.ownershipIdentity &&
			observationMatches(before, slot.desired.installation)
		) {
			if (!before.enabled) mutations.push({ ...slot, driver, before, action: "enable" });
			continue;
		}
		mutations.push({
			...slot,
			driver,
			before,
			action: before ? "replace" : "install",
		});
	}

	const touched: PlannedMutation[] = [];
	return {
		nextReceipt: desiredReceipt(input.prepared),
		apply() {
			for (const mutation of mutations) {
				if (!observationUnchanged(mutation.driver.observe(mutation.name), mutation.before)) {
					throw new Error("native Agent Plugin changed after ownership was verified");
				}
				touched.push(mutation);
				if (mutation.action === "remove" || mutation.action === "replace") {
					mutation.driver.remove(mutation.name);
				}
				if (mutation.action === "install" || mutation.action === "replace") {
					if (!mutation.desired) throw new Error("Agent Plugin mutation plan is invalid");
					const installed = mutation.driver.install(mutation.desired);
					mutation.driver.setEnabled(installed, true);
				}
				if (mutation.action === "enable") {
					if (!mutation.before) throw new Error("Agent Plugin mutation plan is invalid");
					mutation.driver.setEnabled(mutation.before, true);
				}
				const observed = mutation.driver.observe(mutation.name);
				if (mutation.desired) {
					if (!observationMatches(observed, mutation.desired.installation) || !observed.enabled) {
						throw new Error("native Agent Plugin did not converge to the desired state");
					}
				} else if (observed) {
					throw new Error("native Agent Plugin uninstall did not converge");
				}
			}
		},
		rollback() {
			const errors: string[] = [];
			for (const mutation of [...touched].reverse()) {
				try {
					const current = mutation.driver.observe(mutation.name);
					if (mutation.previous && mutation.before) {
						if (observationMatches(current, mutation.previous.installation)) {
							if (current.enabled !== mutation.before.enabled) {
								mutation.driver.setEnabled(current, mutation.before.enabled);
							}
							continue;
						}
						if (current) {
							if (
								!mutation.desired ||
								!observationMatches(current, mutation.desired.installation)
							) {
								throw new Error("refusing to replace an unknown Agent Plugin during rollback");
							}
							mutation.driver.remove(mutation.name);
						}
						const restored = mutation.driver.install(mutation.previous);
						mutation.driver.setEnabled(restored, mutation.before.enabled);
					} else if (current) {
						if (!mutation.desired || !observationMatches(current, mutation.desired.installation)) {
							throw new Error("refusing to remove an unknown Agent Plugin during rollback");
						}
						mutation.driver.remove(mutation.name);
					}
				} catch {
					errors.push(`runtime ${mutation.runtime} Agent Plugin ${mutation.name} rollback failed`);
				}
			}
			touched.length = 0;
			return errors;
		},
	};
}
