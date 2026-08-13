import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runHermesAgentPluginCanary } from "./hermes-agent-plugin-canary-client";
import {
	type HostedAgentPluginReceipt,
	type HostedAgentPluginRuntime,
	hostedAgentPluginDirectoryDigest,
	type PreparedHostedAgentPlugin,
	type PreparedHostedAgentPlugins,
	withPreparedAgentPluginDirectory,
} from "./hosted-agent-plugin-package";
import { AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR } from "./manifest-contract";
import {
	openClawAgentPluginInspectSchema,
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
	available(command: string): boolean;
	run(input: AgentPluginCommandInput): AgentPluginCommandResult;
}

interface HostedAgentPluginPackageProof {
	runtime: HostedAgentPluginRuntime;
	command: string;
	name: string;
	ownershipIdentity: string;
	nativeId: string;
}

export interface HostedAgentPluginCapabilityProof {
	readonly [capabilityProofMarker]: true;
	readonly runner: HostedAgentPluginCommandRunner;
	readonly packages: ReadonlyMap<string, HostedAgentPluginPackageProof>;
}

export type HermesRemoteCapabilityProbe = (input: {
	command: string;
	home: string;
	runner: HostedAgentPluginCommandRunner;
}) => void;

const defaultCommandRunner: HostedAgentPluginCommandRunner = {
	available: commandResolvable,
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

// `hermes plugins list --json` emits this array at
// https://github.com/NousResearch/hermes-agent/blob/66a41616208135198dfe96d0e3b8e5510b20d035/hermes_cli/plugins_cmd.py
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
	compatible: boolean;
	mcpServerNames: readonly string[];
	hasComponentDiagnostics: boolean;
	hasUnsupportedComponents: boolean;
	installPath: string | null;
	contentDigest: string | null;
}

interface NativeAgentPluginDriver {
	runtime: HostedAgentPluginRuntime;
	installTarget(nativeId: string): string;
	mutationStateTargets(): readonly string[];
	observe(name: string, nativeId?: string): NativePluginObservation | null;
	install(prepared: PreparedHostedAgentPlugin): NativePluginObservation;
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
	return join(
		home,
		runtime === "openclaw" ? ".openclaw" : ".hermes",
		runtime === "openclaw" ? "extensions" : "plugins",
		nativeId,
	);
}

function nativeInstallTargetExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
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
		const compatible =
			inspect.plugin.format === "bundle" &&
			inspect.plugin.bundleFormat === "agent" &&
			inspect.install.source === "path";
		let installPath: string | null = null;
		let contentDigest: string | null = null;
		if (compatible) {
			if (!inspect.install.installPath) {
				throw new Error("OpenClaw did not report a controlled Agent Plugin install path");
			}
			installPath = assertTrustedInstalledDirectory(
				input.home,
				"openclaw",
				inspect.plugin.id,
				inspect.install.installPath,
			);
			contentDigest = hostedAgentPluginDirectoryDigest(installPath);
		}
		return {
			runtime: "openclaw",
			name: observedName,
			nativeId: inspect.plugin.id,
			version,
			enabled: inspect.plugin.enabled && inspect.plugin.status === "loaded",
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
		mutationStateTargets() {
			const database = join(input.home, ".openclaw", "state", "openclaw.sqlite");
			return [database, `${database}-wal`, `${database}-shm`];
		},
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
		remove(observation) {
			if (!observation.compatible) {
				throw new Error("refusing to remove an unmanaged OpenClaw plugin");
			}
			if (observation.enabled) this.setEnabled(observation, false);
			const result = run(["plugins", "uninstall", observation.nativeId, "--force"]);
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
			installPath = assertTrustedInstalledDirectory(input.home, "hermes", plugin.name);
			contentDigest = hostedAgentPluginDirectoryDigest(installPath, {
				ignoreTopLevelGitMetadata: true,
			});
		}
		return {
			runtime: "hermes",
			name: plugin.name,
			nativeId: plugin.name,
			version: plugin.version,
			enabled: plugin.status === "enabled",
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
		mutationStateTargets: () => [],
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
		remove(observation) {
			if (!observation.compatible) throw new Error("refusing to remove an unmanaged Hermes plugin");
			if (observation.enabled) this.setEnabled(observation, false);
			const result = run(["plugins", "remove", observation.nativeId]);
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

function packageProofKey(runtime: HostedAgentPluginRuntime, ownershipIdentity: string): string {
	return `${runtime}\0${ownershipIdentity}`;
}

const defaultHermesRemoteCapabilityProbe: HermesRemoteCapabilityProbe = (input) => {
	runHermesAgentPluginCanary({
		home: input.home,
		runOneShot: ({ args, environmentOverrides, timeoutMs }) =>
			input.runner.run({
				command: input.command,
				args,
				home: input.home,
				cwd: input.home,
				environmentOverrides: {
					...isolatedNativeEnvironment("hermes", input.home),
					...environmentOverrides,
				},
				timeoutMs,
			}),
		withEnabledCanary: (canary, prove) => {
			const driver = createHermesDriver(input);
			const installed = driver.install(canary);
			try {
				driver.setEnabled(installed, true);
				prove();
				const enabled = driver.observe(canary.name, installed.nativeId);
				if (!enabled?.enabled) throw new Error();
			} finally {
				const current = driver.observe(canary.name, installed.nativeId);
				if (current) {
					if (current.enabled) driver.setEnabled(current, false);
					driver.remove({ ...current, enabled: false });
				}
			}
		},
	});
};

interface CapabilityProbePackage {
	runtime: HostedAgentPluginRuntime;
	prepared: PreparedHostedAgentPlugin;
}

function capabilityProbePackages(prepared: PreparedHostedAgentPlugins): CapabilityProbePackage[] {
	const packages = new Map<string, CapabilityProbePackage>();
	for (const plugin of prepared.desired.values()) {
		packages.set(packageProofKey(prepared.runtime, plugin.installation.ownershipIdentity), {
			runtime: prepared.runtime,
			prepared: plugin,
		});
	}
	const previousRuntime = prepared.previousReceipt?.runtime;
	if (previousRuntime) {
		for (const plugin of prepared.rollback.values()) {
			packages.set(packageProofKey(previousRuntime, plugin.installation.ownershipIdentity), {
				runtime: previousRuntime,
				prepared: plugin,
			});
		}
	}
	return [...packages.values()].sort((left, right) =>
		`${left.runtime}\0${left.prepared.installation.ownershipIdentity}`.localeCompare(
			`${right.runtime}\0${right.prepared.installation.ownershipIdentity}`,
		),
	);
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
			openClawComponentsMatch &&
			observation.name === prepared.name &&
			observation.nativeId === nativeId &&
			observation.version === prepared.installation.version &&
			observation.contentDigest === prepared.installation.contentDigest,
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
		current.compatible === previous.compatible &&
		stringArraysEqual(current.mcpServerNames, previous.mcpServerNames) &&
		current.hasComponentDiagnostics === previous.hasComponentDiagnostics &&
		current.hasUnsupportedComponents === previous.hasUnsupportedComponents &&
		current.installPath === previous.installPath &&
		current.contentDigest === previous.contentDigest
	);
}

function probeNativeCapability(input: {
	runtime: HostedAgentPluginRuntime;
	command: string;
	prepared: PreparedHostedAgentPlugin;
	runner: HostedAgentPluginCommandRunner;
	hermesRemoteCapabilityProbe: HermesRemoteCapabilityProbe;
}): string {
	if (!isAbsolute(input.command) || !input.runner.available(input.command)) {
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
		if (!observationMatches(installed, input.prepared, installed.nativeId)) throw new Error();
		driver.setEnabled(installed, true);
		const enabled = driver.observe(input.prepared.name, installed.nativeId);
		if (!observationMatches(enabled, input.prepared, installed.nativeId) || !enabled.enabled) {
			throw new Error();
		}
		driver.setEnabled(enabled, false);
		const disabled = driver.observe(input.prepared.name, installed.nativeId);
		if (!observationMatches(disabled, input.prepared, installed.nativeId) || disabled.enabled) {
			throw new Error();
		}
		driver.remove(disabled);
		if (driver.observe(input.prepared.name, installed.nativeId) !== null) throw new Error();
		if (input.runtime === "hermes" && input.prepared.hasStreamableHttpMcp) {
			input.hermesRemoteCapabilityProbe({
				command: input.command,
				home,
				runner: input.runner,
			});
		}
		return installed.nativeId;
	} catch {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function assertNoNativeIdentityCollisions(packages: Iterable<HostedAgentPluginPackageProof>): void {
	const namesByNativeId = new Map<string, string>();
	for (const proof of packages) {
		const key = `${proof.runtime}\0${proof.nativeId}`;
		const existing = namesByNativeId.get(key);
		if (existing !== undefined && existing !== proof.name) {
			throw new Error("Agent Plugin packages resolve to the same native identity");
		}
		namesByNativeId.set(key, proof.name);
	}
}

export function proveHostedAgentPluginCapabilities(input: {
	prepared: PreparedHostedAgentPlugins;
	commands: HostedAgentPluginCommands;
	runner?: HostedAgentPluginCommandRunner;
	hermesRemoteCapabilityProbe?: HermesRemoteCapabilityProbe;
}): HostedAgentPluginCapabilityProof {
	const runner = input.runner ?? defaultCommandRunner;
	const packages = new Map<string, HostedAgentPluginPackageProof>();
	let hermesRemoteProven = false;
	for (const item of capabilityProbePackages(input.prepared)) {
		const command = input.commands[item.runtime];
		const nativeId = probeNativeCapability({
			runtime: item.runtime,
			command,
			prepared: item.prepared,
			runner,
			hermesRemoteCapabilityProbe: (probeInput) => {
				if (hermesRemoteProven) return;
				(input.hermesRemoteCapabilityProbe ?? defaultHermesRemoteCapabilityProbe)(probeInput);
				hermesRemoteProven = true;
			},
		});
		const proof = {
			runtime: item.runtime,
			command,
			name: item.prepared.name,
			ownershipIdentity: item.prepared.installation.ownershipIdentity,
			nativeId,
		};
		packages.set(packageProofKey(proof.runtime, proof.ownershipIdentity), proof);
	}
	assertNoNativeIdentityCollisions(packages.values());
	return { [capabilityProofMarker]: true, runner, packages };
}

function assertCapabilityProof(input: {
	prepared: PreparedHostedAgentPlugins;
	commands: HostedAgentPluginCommands;
	runner: HostedAgentPluginCommandRunner;
	proof: HostedAgentPluginCapabilityProof;
}): void {
	if (input.proof[capabilityProofMarker] !== true || input.proof.runner !== input.runner) {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	}
	const expected = capabilityProbePackages(input.prepared);
	if (input.proof.packages.size !== expected.length) {
		throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	}
	for (const item of expected) {
		const ownershipIdentity = item.prepared.installation.ownershipIdentity;
		const proof = input.proof.packages.get(packageProofKey(item.runtime, ownershipIdentity));
		if (
			!proof ||
			proof.runtime !== item.runtime ||
			proof.command !== input.commands[item.runtime] ||
			proof.name !== item.prepared.name ||
			proof.ownershipIdentity !== ownershipIdentity
		) {
			throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
		}
		assertNativeId(proof.nativeId);
		if (item.prepared.receiptNativeId && item.prepared.receiptNativeId !== proof.nativeId) {
			throw new Error("Agent Plugin native identity no longer matches its ownership receipt");
		}
	}
	assertNoNativeIdentityCollisions(input.proof.packages.values());
}

function proofFor(
	proof: HostedAgentPluginCapabilityProof,
	runtime: HostedAgentPluginRuntime,
	prepared: PreparedHostedAgentPlugin,
): HostedAgentPluginPackageProof {
	const packageProof = proof.packages.get(
		packageProofKey(runtime, prepared.installation.ownershipIdentity),
	);
	if (!packageProof) throw new Error(AGENT_PLUGIN_INSTALLATIONS_UNSUPPORTED_ERROR);
	return packageProof;
}

function desiredReceipt(
	prepared: PreparedHostedAgentPlugins,
	proof: HostedAgentPluginCapabilityProof,
): HostedAgentPluginReceipt | null {
	if (prepared.desired.size === 0) return null;
	return {
		schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
		runtime: prepared.runtime,
		installations: Object.fromEntries(
			[...prepared.desired].map(([name, plugin]) => [
				name,
				{ ...plugin.installation, nativeId: proofFor(proof, prepared.runtime, plugin).nativeId },
			]),
		),
	};
}

interface PlannedMutation {
	runtime: HostedAgentPluginRuntime;
	name: string;
	nativeId: string;
	driver: NativeAgentPluginDriver;
	desired: PreparedHostedAgentPlugin | null;
	previous: PreparedHostedAgentPlugin | null;
	before: NativePluginObservation | null;
	action: "enable" | "install" | "replace" | "remove";
}

export interface HostedAgentPluginTransaction {
	readonly nextReceipt: HostedAgentPluginReceipt | null;
	readonly snapshotTargets: readonly string[];
	readonly mutationRuntimes: ReadonlySet<HostedAgentPluginRuntime>;
	readonly hasMutations: boolean;
	apply(): boolean;
	rollback(): string[];
}

export function prepareHostedAgentPluginTransaction(input: {
	prepared: PreparedHostedAgentPlugins;
	home: string;
	commands: HostedAgentPluginCommands;
	capabilityProof: HostedAgentPluginCapabilityProof;
	runner?: HostedAgentPluginCommandRunner;
}): HostedAgentPluginTransaction {
	const runner = input.runner ?? defaultCommandRunner;
	assertCapabilityProof({
		prepared: input.prepared,
		commands: input.commands,
		runner,
		proof: input.capabilityProof,
	});
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
	const snapshotTargets = new Set<string>();
	for (const slot of [...slots.values()].sort((left, right) =>
		`${left.runtime}\0${left.name}`.localeCompare(`${right.runtime}\0${right.name}`),
	)) {
		const driver = driverFor(slot.runtime);
		const preparedPackage = slot.desired ?? slot.previous;
		if (!preparedPackage) throw new Error("Agent Plugin transaction slot is empty");
		const packageProof = proofFor(input.capabilityProof, slot.runtime, preparedPackage);
		const nativeId = packageProof.nativeId;
		const installTarget = driver.installTarget(nativeId);
		snapshotTargets.add(installTarget);
		for (const target of driver.mutationStateTargets()) snapshotTargets.add(target);
		const before = driver.observe(slot.name, nativeId);
		if (!before && nativeInstallTargetExists(installTarget)) {
			throw new Error("refusing to replace an unmanaged native Agent Plugin target");
		}
		if (slot.previous) {
			if (before && !observationMatches(before, slot.previous, nativeId)) {
				throw new Error(
					"refusing to mutate an Agent Plugin that no longer matches its ownership receipt",
				);
			}
		} else if (before) {
			throw new Error("refusing to replace an unmanaged native Agent Plugin");
		}
		if (!slot.desired) {
			if (before) mutations.push({ ...slot, nativeId, driver, before, action: "remove" });
			continue;
		}
		if (
			slot.previous?.installation.ownershipIdentity ===
				slot.desired.installation.ownershipIdentity &&
			observationMatches(before, slot.desired, nativeId)
		) {
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

	const touched: PlannedMutation[] = [];
	return {
		nextReceipt: desiredReceipt(input.prepared, input.capabilityProof),
		snapshotTargets: [...snapshotTargets].sort(),
		mutationRuntimes: new Set(mutations.map((mutation) => mutation.runtime)),
		hasMutations: mutations.length > 0,
		apply() {
			for (const mutation of mutations) {
				if (
					!observationUnchanged(
						mutation.driver.observe(mutation.name, mutation.nativeId),
						mutation.before,
					)
				) {
					throw new Error("native Agent Plugin changed after ownership was verified");
				}
				touched.push(mutation);
				if ((mutation.action === "remove" || mutation.action === "replace") && mutation.before) {
					mutation.driver.remove(mutation.before);
				}
				if (mutation.action === "install" || mutation.action === "replace") {
					if (!mutation.desired) throw new Error("Agent Plugin mutation plan is invalid");
					const installed = mutation.driver.install(mutation.desired);
					if (!observationMatches(installed, mutation.desired, mutation.nativeId)) {
						throw new Error("native Agent Plugin installed an unexpected identity or package");
					}
					mutation.driver.setEnabled(installed, true);
				}
				if (mutation.action === "enable") {
					if (!mutation.before) throw new Error("Agent Plugin mutation plan is invalid");
					mutation.driver.setEnabled(mutation.before, true);
				}
				const observed = mutation.driver.observe(mutation.name, mutation.nativeId);
				if (mutation.desired) {
					if (
						!observationMatches(observed, mutation.desired, mutation.nativeId) ||
						!observed.enabled
					) {
						throw new Error("native Agent Plugin did not converge to the desired state");
					}
				} else if (observed) {
					throw new Error("native Agent Plugin uninstall did not converge");
				}
			}
			return mutations.length > 0;
		},
		rollback() {
			const errors: string[] = [];
			for (const mutation of [...touched].reverse()) {
				try {
					const current = mutation.driver.observe(mutation.name, mutation.nativeId);
					if (mutation.previous && mutation.before) {
						if (observationMatches(current, mutation.previous, mutation.nativeId)) {
							if (current.enabled !== mutation.before.enabled) {
								mutation.driver.setEnabled(current, mutation.before.enabled);
							}
							continue;
						}
						if (current) {
							if (
								!mutation.desired ||
								!observationMatches(current, mutation.desired, mutation.nativeId)
							) {
								throw new Error("refusing to replace an unknown Agent Plugin during rollback");
							}
							mutation.driver.remove(current);
						}
						const restored = mutation.driver.install(mutation.previous);
						if (!observationMatches(restored, mutation.previous, mutation.nativeId)) {
							throw new Error("native Agent Plugin rollback restored an unexpected package");
						}
						mutation.driver.setEnabled(restored, mutation.before.enabled);
					} else if (current) {
						if (
							!mutation.desired ||
							!observationMatches(current, mutation.desired, mutation.nativeId)
						) {
							throw new Error("refusing to remove an unknown Agent Plugin during rollback");
						}
						mutation.driver.remove(current);
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
