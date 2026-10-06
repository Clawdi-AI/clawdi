import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { type AgentAdapter, adapterModuleNames } from "../adapters/base";
import { listOpenClawAgentWorkspaces } from "../adapters/openclaw-workspace";
import { getHermesHome } from "../adapters/paths";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	allAdapterEntries,
	builtinSkillTargetDir,
} from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import { getConfig } from "../lib/config";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import {
	assertUniqueVaultWorkspace,
	readEnvironmentRegistration,
	type VaultWorkspaceBinding,
	writeEnvironmentRegistration,
} from "../lib/environment-registration";
import { errMessage } from "../lib/errors";
import { getOrCreateMachineId } from "../lib/machine-identity";
import { requireAuth } from "../lib/require-auth";
import { listRegisteredAgentTypes } from "../lib/select-adapter";
import { isInteractive } from "../lib/tty";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	installReservedManagedSkill,
	managedSkillReservationState,
	migrateLegacyLocalSetupSkill,
	replaceManagedSkillDirectoryAtomic,
} from "../runtime/managed-skill-reservation";
import {
	install as installDaemonService,
	listInstalledAgents,
	restart as restartDaemonService,
	uninstall as uninstallDaemonService,
} from "../serve/installer";

export interface LocalAgentSetupOpts {
	yes?: boolean;
	/** Commander sets this to false for --no-daemon. Undefined means default-on. */
	daemon?: boolean;
}

interface SetupOpts extends LocalAgentSetupOpts {
	agent?: string;
	vaultWorkspace?: string;
	vaultNativeAgent?: string;
}

export async function setup(opts: SetupOpts) {
	if ((opts.vaultWorkspace || opts.vaultNativeAgent) && !opts.agent) {
		throw new Error(
			"Vault workspace options require --agent; a target is never shared across detected agents.",
		);
	}
	const auth = requireAuth();

	let machineId: string;
	let machineName: string;
	try {
		machineId = getOrCreateMachineId();
		machineName = hostname();
	} catch (error) {
		console.error(chalk.red(`Could not prepare local agent identity: ${errMessage(error)}`));
		process.exitCode = 1;
		return;
	}
	const api = new ApiClient({ machineId });
	let vaultBindingChanged = false;
	const noteVaultBindingChange = () => {
		vaultBindingChanged = true;
	};

	if (opts.agent) {
		if (!AGENT_TYPES.includes(opts.agent as AgentType)) {
			console.error(chalk.red(`Unknown agent type: ${opts.agent}`));
			console.error(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			process.exitCode = 1;
			return;
		}
		const type = opts.agent as AgentType;
		const adapter = adapterRegistry[type].create();
		const result = await registerEnv(
			api,
			adapter,
			await adapter.getVersion(),
			machineId,
			machineName,
			auth.userId,
			opts,
			noteVaultBindingChange,
		);
		if (!result.ok) {
			process.exitCode = 1;
			return;
		}
		const integrationsInstalled = await reconcileAgentIntegrations(adapter);
		const daemonInstalled = await maybeInstallDaemons(opts, vaultBindingChanged);
		printSetupNotice(
			[adapterRegistry[type].displayName],
			daemonInstalled,
			integrationsInstalled,
			result.dashboardUrl,
		);
		return;
	}

	// Auto-detect
	console.log(chalk.cyan("Detecting installed agents..."));
	const detected: { adapter: AgentAdapter; version: string | null }[] = [];

	for (const entry of allAdapterEntries()) {
		const adapter = entry.create();
		if (await adapter.detect()) {
			const version = await adapter.getVersion();
			detected.push({ adapter, version });
		}
	}

	if (detected.length === 0) {
		console.error(chalk.yellow("  No supported agents detected."));
		console.error(chalk.gray("  Use --agent to specify manually."));
		return;
	}

	// Select which detected agents to register. --yes auto-picks all;
	// non-interactive (CI / piped) also picks all so scripts can run setup.
	let toRegister: typeof detected;
	if (opts.yes || !isInteractive()) {
		toRegister = detected;
	} else {
		console.log();
		const result = await p.multiselect<string>({
			output: process.stderr,
			message: "Register which agents?",
			options: detected.map((d) => ({
				value: d.adapter.agentType as string,
				label: `${adapterRegistry[d.adapter.agentType].displayName}${d.version ? ` (${d.version})` : ""}`,
				// Hint when an agent dir exists but the binary isn't on PATH —
				// the user sees WHY it's unchecked instead of guessing.
				...(d.version ? {} : { hint: "data only — binary not on PATH" }),
			})),
			// Only pre-select agents whose binary is actually reachable
			// (`getVersion()` non-null). Stale `~/.openclaw/` etc. data dirs
			// from old installs still show — but unchecked, so they're not
			// registered by accident.
			initialValues: detected.filter((d) => d.version !== null).map((d) => d.adapter.agentType),
			required: false,
		});
		if (p.isCancel(result)) {
			p.cancel("Cancelled.", { output: process.stderr });
			return;
		}
		const picked = new Set(result as string[]);
		toRegister = detected.filter((d) => picked.has(d.adapter.agentType));
	}

	if (toRegister.length === 0) {
		console.log(chalk.gray("No agents selected."));
		return;
	}

	console.log();
	const registeredNames: string[] = [];
	let dashboardUrl: string | undefined;
	let integrationsInstalled = false;
	let failedCount = 0;
	for (const { adapter, version } of toRegister) {
		const result = await registerEnv(
			api,
			adapter,
			version,
			machineId,
			machineName,
			auth.userId,
			opts,
			noteVaultBindingChange,
		);
		if (!result.ok) {
			failedCount += 1;
			continue;
		}
		registeredNames.push(adapterRegistry[adapter.agentType].displayName);
		dashboardUrl ??= result.dashboardUrl;
		const installed = await reconcileAgentIntegrations(adapter);
		integrationsInstalled ||= installed;
	}
	if (registeredNames.length > 0) {
		const daemonInstalled = await maybeInstallDaemons(opts, vaultBindingChanged);
		printSetupNotice(registeredNames, daemonInstalled, integrationsInstalled, dashboardUrl);
	}
	if (failedCount > 0) process.exitCode = 1;
}

async function registerEnv(
	api: ApiClient,
	adapter: AgentAdapter,
	agentVersion: string | null,
	machineId: string,
	machineName: string,
	userId?: string,
	opts: SetupOpts = {},
	onVaultBindingChange?: () => void,
): Promise<{ ok: boolean; dashboardUrl?: string }> {
	const agentType = adapter.agentType;
	try {
		const vaultWorkspace = await selectVaultWorkspace(agentType, opts);
		if (vaultWorkspace && !userId)
			throw new Error(
				"A vault workspace needs a signed-in CLI account. Run `clawdi auth login` first; environment-variable credentials aren't enough.",
			);
		const env = unwrap(
			await api.POST("/v1/agents", {
				body: {
					machine_id: machineId,
					machine_name: machineName,
					agent_type: agentType,
					agent_version: agentVersion,
					os: process.platform,
					adapter_modules: adapterModuleNames(adapter),
				},
			}),
		);

		const changed = writeEnvironmentRegistration({
			id: env.id,
			agentType,
			machineId,
			machineName,
			...(userId ? { userId } : {}),
			...(vaultWorkspace ? { vaultWorkspace } : {}),
		});

		if (changed) onVaultBindingChange?.();
		console.log(chalk.green(`✓ ${adapterRegistry[agentType].displayName} registered`));
		const binding = readEnvironmentRegistration(agentType)?.vaultWorkspace;
		console.log(
			chalk.gray(
				binding
					? `Vault directory: ${join(binding.path, ".clawdi", "vaults")}${process.platform === "linux" || process.platform === "darwin" ? "" : " (automatic file sync requires macOS or Linux/WSL)"}`
					: `Vault file sync is disabled. Configure it with clawdi setup --agent ${agentType} --vault-workspace <path>.`,
			),
		);
		return { ok: true, dashboardUrl: env.dashboard_url ?? undefined };
	} catch (e) {
		console.error(
			chalk.red(`  Failed to register ${adapterRegistry[agentType].displayName}: ${errMessage(e)}`),
		);
		return { ok: false };
	}
}

function printSetupNotice(
	agents: string[],
	daemonInstalled: boolean,
	integrationsInstalled: boolean,
	dashboardUrl?: string,
) {
	const lines = ["Clawdi is on for this machine:", `  • Agents: ${agents.join(", ")}`];
	if (integrationsInstalled) lines.push("  • Skill and MCP tools installed for supported agents");
	lines.push(
		daemonInstalled
			? "  • Background sync: session history and skills upload to your account automatically"
			: "  • Background sync: off. Run `clawdi push` to upload manually.",
		"To opt out later:",
		"  • Stop all background sync:   clawdi daemon uninstall",
		"  • Skip a project:   clawdi config set excludeProjects <path>[,<path>]",
	);
	if (dashboardUrl) lines.push(`Open your dashboard: ${dashboardUrl}`);
	console.log();
	console.log(lines.join("\n"));
}

function installDaemonForAllRegisteredAgents(restartExisting: boolean): boolean {
	try {
		const result = installDaemonService();
		if (restartExisting && result.replaced) restartDaemonService();
		const verb = result.replaced ? "updated" : "installed";
		console.log(chalk.green(`✓ Singleton daemon ${verb}`));
		console.log(chalk.gray(`  ${result.instructions}`));
		const failed = cleanupLegacyDaemonUnits();
		if (failed > 0) process.exitCode = 1;
		return true;
	} catch (e) {
		console.error(chalk.yellow(`⚠ Could not install daemon: ${errMessage(e)}`));
		console.error(chalk.gray("  Run manually: clawdi daemon install"));
		process.exitCode = 1;
		return false;
	}
}

function cleanupLegacyDaemonUnits(): number {
	let failed = 0;
	for (const agentType of listInstalledAgents()) {
		try {
			const result = uninstallDaemonService({ agent: agentType });
			if (result.removed) {
				console.log(chalk.green(`✓ Removed legacy per-agent daemon unit for ${agentType}`));
			}
		} catch (e) {
			console.error(
				chalk.yellow(
					`⚠ Could not remove legacy per-agent daemon unit for ${agentType}: ${errMessage(e)}`,
				),
			);
			failed += 1;
		}
	}
	return failed;
}

async function shouldInstallDaemons(opts: SetupOpts): Promise<boolean> {
	if (opts.daemon === false) {
		console.log(chalk.gray("Daemon install skipped (--no-daemon)."));
		return false;
	}
	if (opts.yes || !isInteractive()) return true;

	const result = await p.confirm({
		output: process.stderr,
		message: "Install and start background sync daemons for all registered agents?",
		initialValue: true,
	});
	if (p.isCancel(result)) {
		console.log(chalk.gray("Daemon install skipped."));
		return false;
	}
	return result === true;
}

export async function reconcileAgentIntegrations(adapter: AgentAdapter): Promise<boolean> {
	const entry = adapterRegistry[adapter.agentType];
	const mcpInstalled = (await entry.mcpLifecycle?.register()) ?? false;
	if (!entry.mcpLifecycle && entry.manualMcpHint) console.log(chalk.gray(entry.manualMcpHint));
	const skillInstalled = adapter.skills ? await installBuiltinSkill(adapter.agentType) : false;
	return mcpInstalled && skillInstalled;
}

export async function maybeInstallDaemons(
	opts: LocalAgentSetupOpts,
	restartExisting = false,
): Promise<boolean> {
	if (await shouldInstallDaemons(opts)) return installDaemonsForRegisteredAgents(restartExisting);
	return false;
}

function installDaemonsForRegisteredAgents(restartExisting: boolean): boolean {
	const registered = listRegisteredAgentTypes();
	if (registered.length === 0) {
		console.log(chalk.gray("No registered agents available for daemon install."));
		return false;
	}
	console.log();
	console.log(chalk.cyan("Installing background sync daemon..."));
	return installDaemonForAllRegisteredAgents(restartExisting);
}

async function installBuiltinSkill(agentType: AgentType): Promise<boolean> {
	const targetDir = builtinSkillTargetDir(agentType);
	if (!targetDir) return false;
	const label = adapterRegistry[agentType].displayName;

	const sourceDir = join(resolveCurrentCliResourceRoot(), "skills", "clawdi");
	if (!existsSync(sourceDir)) {
		console.error(chalk.yellow("⚠ Built-in skill not found, skipping."));
		return false;
	}

	const alreadyInstalled = existsSync(join(targetDir, "SKILL.md"));

	try {
		const sourceDigest = managedSkillDirectoryDigest(sourceDir);
		migrateLegacyLocalSetupSkill({
			targetDir,
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		const reservationState = managedSkillReservationState(targetDir);
		if (
			existsSync(targetDir) &&
			reservationState !== "reserved" &&
			managedSkillDirectoryDigest(targetDir) !== sourceDigest
		) {
			throw new Error(`Refusing to replace unmanaged skill at ${targetDir}`);
		}
		installReservedManagedSkill(
			{
				targetDir,
				id: "clawdi",
				version: 1,
				digest: sourceDigest,
				manager: "local-setup",
			},
			() => replaceManagedSkillDirectoryAtomic(sourceDir, targetDir),
			{
				verify: () =>
					existsSync(targetDir) && managedSkillDirectoryDigest(targetDir) === sourceDigest,
				discard: () => rmSync(targetDir, { recursive: true, force: true }),
			},
		);
		console.log(
			chalk.green(`✓ Clawdi skill ${alreadyInstalled ? "updated" : "installed"} in ${label}`),
		);
		return true;
	} catch (error) {
		console.error(chalk.yellow(`⚠ Could not install Clawdi skill (${errMessage(error)}).`));
		return false;
	}
}

async function selectVaultWorkspace(
	agentType: AgentType,
	opts: SetupOpts,
): Promise<VaultWorkspaceBinding | undefined> {
	if (opts.vaultNativeAgent && agentType !== "openclaw")
		throw new Error("--vault-native-agent is only supported for OpenClaw.");
	let path = opts.vaultWorkspace;
	let nativeAgentId = opts.vaultNativeAgent;
	if (nativeAgentId) {
		const entries = listOpenClawAgentWorkspaces().filter((item) => item.id === nativeAgentId);
		const entry = entries.length === 1 ? entries[0] : undefined;
		if (!entry)
			throw new Error("Selected native agent is absent from the official OpenClaw roster.");
		if (path && realpathSync(resolve(path)) !== realpathSync(entry.workspace))
			throw new Error("Vault workspace differs from the selected native agent workspace.");
		path = entry.workspace;
	}
	if (
		!path &&
		!opts.yes &&
		isInteractive() &&
		!readEnvironmentRegistration(agentType)?.vaultWorkspace
	) {
		let candidates: { workspace: string; id?: string }[] = [];
		try {
			if (agentType === "openclaw") candidates = listOpenClawAgentWorkspaces();
			if (agentType === "hermes") {
				const config: unknown = parseYaml(
					readFileSync(join(getHermesHome(), "config.yaml"), "utf8"),
				);
				if (
					config &&
					typeof config === "object" &&
					"terminal" in config &&
					config.terminal &&
					typeof config.terminal === "object" &&
					"cwd" in config.terminal &&
					typeof config.terminal.cwd === "string" &&
					isAbsolute(config.terminal.cwd)
				)
					candidates = [{ workspace: config.terminal.cwd }];
			}
		} catch {
			/* An unavailable native configuration never becomes a guessed directory. */
		}
		if (candidates.length) {
			const selected = await p.select({
				output: process.stderr,
				message: "Deliver this agent's vault files to a native workspace?",
				options: [
					{ value: -1, label: "Not now" },
					...candidates.map((candidate, index) => ({
						value: index,
						label: `${candidate.id ?? agentType}: ${candidate.workspace}`,
					})),
				],
				initialValue: -1,
			});
			if (!p.isCancel(selected) && selected >= 0) {
				path = candidates[selected].workspace;
				nativeAgentId = candidates[selected].id;
			}
		}
	}
	if (!path) return undefined;
	const canonical = realpathSync(resolve(path));
	if (!statSync(canonical).isDirectory())
		throw new Error("Vault workspace must be an existing directory.");
	assertUniqueVaultWorkspace(agentType, canonical);
	return {
		path: canonical,
		apiOrigin: getConfig().apiUrl,
		...(nativeAgentId ? { nativeAgentId } : {}),
	};
}
