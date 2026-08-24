import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getHermesRawConfigFileValue } from "./hermes-config";
import {
	type HostedAgentPluginOwnership,
	type HostedAgentPluginReceipt,
	type HostedAgentPluginRuntime,
	hostedAgentPluginDirectoryDigest,
	type PreparedHostedAgentPlugin,
	type PreparedHostedAgentPlugins,
	withPreparedAgentPluginDirectory,
} from "./hosted-agent-plugin-package";
import {
	openClawAgentPluginInspectSchema,
	openClawPluginListSchema,
} from "./openclaw-plugin-observation";
import { spawnRuntimeUserCommand, withRuntimeUserFileAccess } from "./runtime-user-command";

const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
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
		openclaw: join(home, ".local", "bin", "openclaw"),
		hermes: join(home, ".local", "bin", "hermes"),
	};
}

interface AgentPluginCommandInput {
	command: string;
	args: string[];
	home: string;
	cwd: string;
	environmentOverrides: Readonly<Record<string, string | undefined>>;
	timeoutMs?: number;
}

interface AgentPluginCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export interface HostedAgentPluginCommandRunner {
	run(input: AgentPluginCommandInput): AgentPluginCommandResult;
}
const HERMES_PLUGIN_SCAN_POLICY_KEY = "plugins.scan_on_install";

const defaultCommandRunner: HostedAgentPluginCommandRunner = {
	run(input) {
		const result = spawnRuntimeUserCommand(input.command, input.args, input.home, input.cwd, {
			environmentOverrides: input.environmentOverrides,
			timeoutMs: input.timeoutMs ?? COMMAND_TIMEOUT_MS,
			maxBufferBytes: COMMAND_MAX_BUFFER_BYTES,
		});
		return {
			status: result.status,
			stdout: String(result.stdout ?? ""),
			stderr: String(result.stderr ?? ""),
		};
	},
};

// Hermes exposes package lifecycle state here, but not component inventory.
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
	runtime: HostedAgentPluginRuntime;
	name: string;
	nativeId: string;
	version: string;
	enabled: boolean;
	formatSupported: boolean;
	compatible: boolean;
	mcpServerNames: readonly string[];
	hasComponentDiagnostics: boolean;
	hasUnsupportedComponents: boolean;
	installPath: string | null;
	contentDigest: string | null;
}

interface NativeAgentPluginPackage {
	name: string;
	version: string;
	contentDigest: string;
	mcpServerNames: readonly string[];
	tree: PreparedHostedAgentPlugin["tree"];
}

function nativePackage(prepared: PreparedHostedAgentPlugin): NativeAgentPluginPackage {
	return {
		name: prepared.name,
		version: prepared.installation.version,
		contentDigest: prepared.installation.contentDigest,
		mcpServerNames: prepared.mcpServerNames,
		tree: prepared.tree,
	};
}

interface NativeAgentPluginDriver {
	runtime: HostedAgentPluginRuntime;
	installTarget(nativeId: string): string;
	observe(name: string, nativeId?: string): NativePluginObservation | null;
	install(prepared: NativeAgentPluginPackage): NativePluginObservation;
	setEnabled(observation: NativePluginObservation, enabled: boolean): void;
	remove(observation: NativePluginObservation): void;
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

/** Native CLIs explain failures on stderr; keep a tail so apply errors are diagnosable. */
function nativeCommandFailure(prefix: string, result: AgentPluginCommandResult): Error {
	const detail = (result.stderr.trim() || result.stdout.trim())
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.slice(-8)
		.join("\n");
	return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function assertNativeId(nativeId: string): void {
	if (nativeId.length > 128 || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(nativeId)) {
		throw new Error("native Agent Plugin identity is unsafe");
	}
}

function nativeInstallTarget(
	home: string,
	runtime: HostedAgentPluginRuntime,
	nativeId: string,
): string {
	assertNativeId(nativeId);
	return join(nativeInstallRoot(home, runtime), nativeId);
}

function nativeInstallRoot(home: string, runtime: HostedAgentPluginRuntime): string {
	return join(
		home,
		runtime === "openclaw" ? ".openclaw" : ".hermes",
		runtime === "openclaw" ? "extensions" : "plugins",
	);
}

function nativeInstallTargetNames(home: string, runtime: HostedAgentPluginRuntime): Set<string> {
	const root = nativeInstallRoot(home, runtime);
	try {
		return new Set(readdirSync(root));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
		throw error;
	}
}

function assertTrustedInstalledDirectory(
	home: string,
	runtime: HostedAgentPluginRuntime,
	nativeId: string,
	reportedPath?: string,
): string {
	const expected = resolve(nativeInstallTarget(home, runtime, nativeId));
	if (
		reportedPath !== undefined &&
		(!isAbsolute(reportedPath) || resolve(reportedPath) !== expected)
	) {
		throw new Error("native Agent Plugin install path is outside its controlled target");
	}
	const resolvedHome = resolve(home);
	const candidate = relative(resolvedHome, expected);
	if (candidate.startsWith("..") || isAbsolute(candidate)) {
		throw new Error("native Agent Plugin install path is outside runtime HOME");
	}
	let current = resolvedHome;
	for (const segment of candidate.split("/")) {
		if (!segment) continue;
		current = join(current, segment);
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("native Agent Plugin install path is not a trusted directory");
		}
	}
	return expected;
}

function inspectInstalledPluginDirectory(input: {
	home: string;
	runtime: HostedAgentPluginRuntime;
	nativeId: string;
	reportedPath?: string;
	ignoreTopLevelGitMetadata?: boolean;
}): { installPath: string; contentDigest: string } {
	const installPath = assertTrustedInstalledDirectory(
		input.home,
		input.runtime,
		input.nativeId,
		input.reportedPath,
	);
	return {
		installPath,
		contentDigest: hostedAgentPluginDirectoryDigest(installPath, {
			ignoreTopLevelGitMetadata: input.ignoreTopLevelGitMetadata,
		}),
	};
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
	const observe = (name: string, nativeId?: string): NativePluginObservation | null => {
		if (nativeId !== undefined) assertNativeId(nativeId);
		const list = parseJson(run(["plugins", "list", "--json"]), openClawPluginListSchema);
		const matches = list.plugins.filter(
			(plugin) => plugin.name === name || (nativeId !== undefined && plugin.id === nativeId),
		);
		if (matches.length === 0) return null;
		if (matches.length !== 1) throw new Error("native Agent Plugin identity is ambiguous");
		const listed = matches[0];
		if (!listed) throw new Error("native Agent Plugin observation is missing");
		assertNativeId(listed.id);
		const inspect = parseJson(
			run(["plugins", "inspect", listed.id, "--json"]),
			openClawAgentPluginInspectSchema,
		);
		const observedName = inspect.plugin.name ?? listed.name ?? "";
		const version =
			inspect.plugin.version ?? inspect.install.resolvedVersion ?? inspect.install.version ?? "";
		const formatSupported =
			inspect.plugin.format === "bundle" && inspect.plugin.bundleFormat === "agent";
		const compatible = inspect.install.source === "path";
		let installPath: string | null = null;
		let contentDigest: string | null = null;
		if (compatible) {
			if (!inspect.install.installPath) {
				throw new Error("OpenClaw did not report a controlled Agent Plugin install path");
			}
			({ installPath, contentDigest } = inspectInstalledPluginDirectory({
				home: input.home,
				runtime: "openclaw",
				nativeId: inspect.plugin.id,
				reportedPath: inspect.install.installPath,
			}));
		}
		return {
			runtime: "openclaw",
			name: observedName,
			nativeId: inspect.plugin.id,
			version,
			enabled: inspect.plugin.enabled && inspect.plugin.status === "loaded",
			formatSupported,
			compatible,
			mcpServerNames: inspect.mcpServers.map((server) => server.name).sort(),
			hasComponentDiagnostics: inspect.diagnostics.length > 0,
			hasUnsupportedComponents: inspect.mcpServers.some((server) => server.unsupported === true),
			installPath,
			contentDigest,
		};
	};
	return {
		runtime: "openclaw",
		installTarget: (nativeId) => nativeInstallTarget(input.home, "openclaw", nativeId),
		observe,
		install(prepared) {
			withPreparedAgentPluginDirectory(prepared, (sourceDir) => {
				const result = run(["plugins", "install", sourceDir, "--force"]);
				if (result.status !== 0) {
					throw nativeCommandFailure("OpenClaw native Agent Plugin install failed", result);
				}
			});
			const installed = observe(prepared.name);
			if (!installed) {
				throw new Error("OpenClaw did not report the installed Agent Plugin");
			}
			return installed;
		},
		setEnabled(observation, enabled) {
			const result = run(["plugins", enabled ? "enable" : "disable", observation.nativeId]);
			if (result.status !== 0) {
				throw nativeCommandFailure("OpenClaw native Agent Plugin state change failed", result);
			}
		},
		remove(observation) {
			if (!observation.compatible) {
				throw new Error("refusing to remove an unmanaged OpenClaw plugin");
			}
			if (observation.enabled) this.setEnabled(observation, false);
			const result = run(["plugins", "uninstall", observation.nativeId, "--force"]);
			if (result.status !== 0) {
				throw nativeCommandFailure("OpenClaw native Agent Plugin uninstall failed", result);
			}
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

type HermesNativeCommand = (args: string[]) => AgentPluginCommandResult;

function ensureHermesPluginScanDisabled(home: string, run: HermesNativeCommand): void {
	const configPath = join(home, ".hermes", "config.yaml");
	const current = getHermesRawConfigFileValue(configPath, HERMES_PLUGIN_SCAN_POLICY_KEY);
	if (current.exists && current.value === false) return;

	// Remove this persistent policy when NousResearch/hermes-agent#89704 ships
	// an immutable-ref install exemption in the supported Hermes release.
	const result = run(["config", "set", "--force", HERMES_PLUGIN_SCAN_POLICY_KEY, "false"]);
	if (result.status !== 0) {
		throw nativeCommandFailure("Hermes Agent Plugin scan policy update failed", result);
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
	const observe = (name: string, nativeId = name): NativePluginObservation | null => {
		assertNativeId(nativeId);
		const list = parseJson(run(["plugins", "list", "--json"]), hermesPluginListSchema);
		const matches = list.filter((plugin) => plugin.name === name || plugin.name === nativeId);
		if (matches.length === 0) return null;
		if (matches.length !== 1) throw new Error("native Agent Plugin identity is ambiguous");
		const plugin = matches[0];
		if (!plugin) throw new Error("native Agent Plugin observation is missing");
		const compatible = plugin.source === "git";
		let installPath: string | null = null;
		let contentDigest: string | null = null;
		if (compatible) {
			({ installPath, contentDigest } = inspectInstalledPluginDirectory({
				home: input.home,
				runtime: "hermes",
				nativeId: plugin.name,
				ignoreTopLevelGitMetadata: true,
			}));
		}
		return {
			runtime: "hermes",
			name: plugin.name,
			nativeId: plugin.name,
			version: plugin.version,
			enabled: plugin.status === "enabled",
			formatSupported: true,
			compatible,
			mcpServerNames: [],
			hasComponentDiagnostics: false,
			hasUnsupportedComponents: false,
			installPath,
			contentDigest,
		};
	};
	return {
		runtime: "hermes",
		installTarget: (nativeId) => nativeInstallTarget(input.home, "hermes", nativeId),
		observe,
		install(prepared) {
			withPreparedAgentPluginDirectory(prepared, (sourceDir) => {
				ensureHermesPluginScanDisabled(input.home, run);
				initializeLocalGitTransport(input.runner, "hermes", input.home, sourceDir);
				const result = run([
					"plugins",
					"install",
					pathToFileURL(sourceDir).href,
					"--force",
					"--no-enable",
				]);
				if (result.status !== 0) {
					throw nativeCommandFailure("Hermes native Agent Plugin install failed", result);
				}
			});
			const installed = observe(prepared.name);
			if (!installed) throw new Error("Hermes did not report the installed Agent Plugin");
			return installed;
		},
		setEnabled(observation, enabled) {
			const args = ["plugins", enabled ? "enable" : "disable", observation.nativeId];
			if (enabled) args.push("--no-allow-tool-override");
			const result = run(args);
			if (result.status !== 0) {
				throw nativeCommandFailure("Hermes native Agent Plugin state change failed", result);
			}
		},
		remove(observation) {
			if (!observation.compatible) throw new Error("refusing to remove an unmanaged Hermes plugin");
			if (observation.enabled) this.setEnabled(observation, false);
			const result = run(["plugins", "remove", observation.nativeId]);
			if (result.status !== 0) {
				throw nativeCommandFailure("Hermes native Agent Plugin remove failed", result);
			}
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

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function observationMatches(
	observation: NativePluginObservation | null,
	prepared: PreparedHostedAgentPlugin,
	nativeId: string,
): observation is NativePluginObservation {
	const openClawComponentsMatch =
		observation?.runtime !== "openclaw" ||
		(!observation.hasComponentDiagnostics &&
			!observation.hasUnsupportedComponents &&
			stringArraysEqual(observation.mcpServerNames, prepared.mcpServerNames));
	return Boolean(
		observation?.compatible &&
			observation.formatSupported &&
			openClawComponentsMatch &&
			observation.name === prepared.name &&
			observation.nativeId === nativeId &&
			observation.version === prepared.installation.version &&
			observation.contentDigest === prepared.installation.contentDigest,
	);
}

function observationMatchesOwnership(
	observation: NativePluginObservation | null,
	ownership: HostedAgentPluginOwnership,
): observation is NativePluginObservation {
	return Boolean(
		observation?.compatible &&
			observation.formatSupported &&
			observation.runtime === ownership.runtime &&
			observation.name === ownership.name &&
			observation.nativeId === ownership.nativeId &&
			observation.version === ownership.installation.version &&
			observation.contentDigest === ownership.installation.contentDigest,
	);
}

function observationUnchanged(
	current: NativePluginObservation | null,
	previous: NativePluginObservation | null,
): boolean {
	if (!current || !previous) return current === previous;
	return (
		current.runtime === previous.runtime &&
		current.name === previous.name &&
		current.nativeId === previous.nativeId &&
		current.version === previous.version &&
		current.enabled === previous.enabled &&
		current.formatSupported === previous.formatSupported &&
		current.compatible === previous.compatible &&
		stringArraysEqual(current.mcpServerNames, previous.mcpServerNames) &&
		current.hasComponentDiagnostics === previous.hasComponentDiagnostics &&
		current.hasUnsupportedComponents === previous.hasUnsupportedComponents &&
		current.installPath === previous.installPath &&
		current.contentDigest === previous.contentDigest
	);
}

function desiredReceipt(
	prepared: PreparedHostedAgentPlugins,
	nativeIds: ReadonlyMap<string, string>,
): HostedAgentPluginReceipt | null {
	if (prepared.desired.size === 0) return null;
	const installations: HostedAgentPluginReceipt["installations"] = {};
	for (const [name, plugin] of prepared.desired) {
		const nativeId = nativeIds.get(name);
		if (!nativeId) throw new Error("Agent Plugin native identity was not resolved during apply");
		installations[name] = { ...plugin.installation, nativeId };
	}
	return {
		schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
		runtime: prepared.runtime,
		installations,
	};
}

interface PlannedMutation {
	runtime: HostedAgentPluginRuntime;
	name: string;
	nativeId: string | null;
	driver: NativeAgentPluginDriver;
	desired: PreparedHostedAgentPlugin | null;
	previous: HostedAgentPluginOwnership | null;
	before: NativePluginObservation | null;
	action: "enable" | "install" | "replace" | "remove";
}

export interface HostedAgentPluginTransaction {
	readonly mutationNames: readonly string[];
	readonly hasMutations: boolean;
	apply(): HostedAgentPluginReceipt | null;
}

export function prepareHostedAgentPluginTransaction(input: {
	prepared: PreparedHostedAgentPlugins;
	home: string;
	commands: HostedAgentPluginCommands;
	runner?: HostedAgentPluginCommandRunner;
}): HostedAgentPluginTransaction {
	const runner = input.runner ?? defaultCommandRunner;
	const drivers = new Map<HostedAgentPluginRuntime, NativeAgentPluginDriver>();
	const driverFor = (runtime: HostedAgentPluginRuntime): NativeAgentPluginDriver => {
		const existing = drivers.get(runtime);
		if (existing) return existing;
		const driver = createNativeDriver({
			runtime,
			command: input.commands[runtime],
			home: input.home,
			runner,
		});
		drivers.set(runtime, driver);
		return driver;
	};
	const slots = new Map<
		string,
		{
			runtime: HostedAgentPluginRuntime;
			name: string;
			desired: PreparedHostedAgentPlugin | null;
			previous: HostedAgentPluginOwnership | null;
		}
	>();
	for (const [name, previous] of input.prepared.previous) {
		slots.set(`${previous.runtime}\0${name}`, {
			runtime: previous.runtime,
			name,
			desired: null,
			previous,
		});
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
	const resolvedNativeIds = new Map<string, string>();
	for (const slot of [...slots.values()].sort((left, right) =>
		`${left.runtime}\0${left.name}`.localeCompare(`${right.runtime}\0${right.name}`),
	)) {
		const driver = driverFor(slot.runtime);
		const nativeId = slot.previous?.nativeId ?? null;
		const before = driver.observe(slot.name, nativeId ?? undefined);
		if (nativeId && !before && nativeInstallTargetNames(input.home, slot.runtime).has(nativeId)) {
			throw new Error("refusing to replace an unmanaged native Agent Plugin target");
		}
		if (slot.previous) {
			if (before && !observationMatchesOwnership(before, slot.previous)) {
				throw new Error(
					"refusing to mutate an Agent Plugin that no longer matches its ownership receipt",
				);
			}
		} else if (before) {
			throw new Error("refusing to replace an unmanaged native Agent Plugin");
		}
		if (!slot.desired) {
			if (!nativeId) throw new Error("Agent Plugin transaction slot is empty");
			if (before) mutations.push({ ...slot, nativeId, driver, before, action: "remove" });
			continue;
		}
		if (
			nativeId &&
			slot.previous?.installation.ownershipIdentity ===
				slot.desired.installation.ownershipIdentity &&
			observationMatches(before, slot.desired, nativeId)
		) {
			resolvedNativeIds.set(slot.name, nativeId);
			if (!before.enabled) {
				mutations.push({ ...slot, nativeId, driver, before, action: "enable" });
			}
			continue;
		}
		mutations.push({
			...slot,
			nativeId,
			driver,
			before,
			action: before ? "replace" : "install",
		});
	}
	return {
		mutationNames: [...new Set(mutations.map((mutation) => mutation.name))].sort(),
		hasMutations: mutations.length > 0,
		apply() {
			return withRuntimeUserFileAccess(() => {
				const installTargetsBefore = new Map<HostedAgentPluginRuntime, Set<string>>();
				for (const mutation of mutations) {
					if (mutation.nativeId || installTargetsBefore.has(mutation.runtime)) continue;
					installTargetsBefore.set(
						mutation.runtime,
						nativeInstallTargetNames(input.home, mutation.runtime),
					);
				}
				const namesByNativeId = new Map<string, string>();
				const claimNativeId = (name: string, nativeId: string): void => {
					const existing = namesByNativeId.get(nativeId);
					if (existing !== undefined && existing !== name) {
						throw new Error("Agent Plugin packages resolve to the same native identity");
					}
					namesByNativeId.set(nativeId, name);
				};
				for (const mutation of mutations) {
					if (
						!observationUnchanged(
							mutation.driver.observe(mutation.name, mutation.nativeId ?? undefined),
							mutation.before,
						)
					) {
						throw new Error("native Agent Plugin changed after ownership was verified");
					}
					if ((mutation.action === "remove" || mutation.action === "replace") && mutation.before) {
						mutation.driver.remove(mutation.before);
					}
					if (mutation.action === "install" || mutation.action === "replace") {
						if (!mutation.desired) throw new Error("Agent Plugin mutation plan is invalid");
						const installed = mutation.driver.install(nativePackage(mutation.desired));
						if (mutation.nativeId && installed.nativeId !== mutation.nativeId) {
							throw new Error(
								"Agent Plugin native identity no longer matches its ownership receipt",
							);
						}
						if (
							!mutation.nativeId &&
							installTargetsBefore.get(mutation.runtime)?.has(installed.nativeId)
						) {
							throw new Error("refusing to replace an unmanaged native Agent Plugin target");
						}
						if (!observationMatches(installed, mutation.desired, installed.nativeId)) {
							throw new Error("native Agent Plugin installed an unexpected identity or package");
						}
						claimNativeId(mutation.name, installed.nativeId);
						resolvedNativeIds.set(mutation.name, installed.nativeId);
						mutation.driver.setEnabled(installed, true);
					}
					if (mutation.action === "enable") {
						if (!mutation.before) throw new Error("Agent Plugin mutation plan is invalid");
						mutation.driver.setEnabled(mutation.before, true);
					}
					const nativeId = mutation.desired
						? resolvedNativeIds.get(mutation.name)
						: mutation.nativeId;
					if (!nativeId) throw new Error("Agent Plugin mutation plan is invalid");
					const observed = mutation.driver.observe(mutation.name, nativeId);
					if (mutation.desired) {
						if (!observationMatches(observed, mutation.desired, nativeId) || !observed.enabled) {
							throw new Error("native Agent Plugin did not converge to the desired state");
						}
					} else if (observed) {
						throw new Error("native Agent Plugin uninstall did not converge");
					}
				}
				for (const plugin of input.prepared.desired.values()) {
					const nativeId = resolvedNativeIds.get(plugin.name);
					if (!nativeId)
						throw new Error("Agent Plugin native identity was not resolved during apply");
					claimNativeId(plugin.name, nativeId);
					const observed = driverFor(input.prepared.runtime).observe(plugin.name, nativeId);
					if (!observationMatches(observed, plugin, nativeId) || !observed.enabled) {
						throw new Error("native Agent Plugin did not converge to the desired state");
					}
				}
				return desiredReceipt(input.prepared, resolvedNativeIds);
			});
		},
	};
}
