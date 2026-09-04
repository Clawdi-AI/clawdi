import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { type AgentAdapter, adapterModuleNames } from "../adapters/base";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	allAdapterEntries,
	builtinSkillTargetDir,
} from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import { getAuth } from "../lib/config";
import { resolveCurrentCliResourceRoot } from "../lib/current-cli-invocation";
import { writeEnvironmentRegistration } from "../lib/environment-registration";
import { errMessage } from "../lib/errors";
import { getOrCreateMachineId } from "../lib/machine-identity";
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
	uninstall as uninstallDaemonService,
} from "../serve/installer";

export interface LocalAgentSetupOpts {
	yes?: boolean;
	/** Commander sets this to false for --no-daemon. Undefined means default-on. */
	daemon?: boolean;
}

interface SetupOpts extends LocalAgentSetupOpts {
	agent?: string;
}

export async function setup(opts: SetupOpts) {
	const auth = getAuth();
	if (!auth) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	let machineId: string;
	let machineName: string;
	try {
		machineId = getOrCreateMachineId();
		machineName = hostname();
	} catch (error) {
		console.log(chalk.red(`Could not prepare local Agent identity: ${errMessage(error)}`));
		process.exitCode = 1;
		return;
	}
	const api = new ApiClient({ machineId });

	if (opts.agent) {
		if (!AGENT_TYPES.includes(opts.agent as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${opts.agent}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			process.exitCode = 1;
			return;
		}
		const type = opts.agent as AgentType;
		const adapter = adapterRegistry[type].create();
		if (
			!(await registerEnv(
				api,
				adapter,
				await adapter.getVersion(),
				machineId,
				machineName,
				auth.userId,
			))
		) {
			process.exitCode = 1;
			return;
		}
		await reconcileAgentIntegrations(adapter);
		await maybeInstallDaemons(opts);
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
		console.log(chalk.yellow("  No supported agents detected."));
		console.log(chalk.gray("  Use --agent to specify manually."));
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
			p.cancel("Cancelled.");
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
	let registeredCount = 0;
	let failedCount = 0;
	for (const { adapter, version } of toRegister) {
		if (!(await registerEnv(api, adapter, version, machineId, machineName, auth.userId))) {
			failedCount += 1;
			continue;
		}
		registeredCount += 1;
		await reconcileAgentIntegrations(adapter);
	}
	if (registeredCount > 0) await maybeInstallDaemons(opts);
	if (failedCount > 0) process.exitCode = 1;
}

async function registerEnv(
	api: ApiClient,
	adapter: AgentAdapter,
	agentVersion: string | null,
	machineId: string,
	machineName: string,
	userId?: string,
): Promise<boolean> {
	const agentType = adapter.agentType;
	try {
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

		writeEnvironmentRegistration({
			id: env.id,
			agentType,
			machineId,
			machineName,
			...(userId ? { userId } : {}),
		});

		console.log(chalk.green(`✓ ${adapterRegistry[agentType].displayName} registered`));
		return true;
	} catch (e) {
		console.log(
			chalk.red(`  Failed to register ${adapterRegistry[agentType].displayName}: ${errMessage(e)}`),
		);
		return false;
	}
}

function installDaemonForAllRegisteredAgents() {
	try {
		const result = installDaemonService();
		const verb = result.replaced ? "updated" : "installed";
		console.log(chalk.green(`✓ Singleton daemon ${verb}`));
		console.log(chalk.gray(`  ${result.instructions}`));
		const failed = cleanupLegacyDaemonUnits();
		if (failed > 0) process.exitCode = 1;
	} catch (e) {
		console.log(chalk.yellow(`⚠ Could not install daemon: ${errMessage(e)}`));
		console.log(chalk.gray("  Run manually: clawdi daemon install"));
		process.exitCode = 1;
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
			console.log(
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
		message: "Install and start background sync daemons for all registered agents?",
		initialValue: true,
	});
	if (p.isCancel(result)) {
		console.log(chalk.gray("Daemon install skipped."));
		return false;
	}
	return result === true;
}

export async function reconcileAgentIntegrations(adapter: AgentAdapter): Promise<void> {
	await adapterRegistry[adapter.agentType].mcpLifecycle?.register();
	if (adapter.skills) await installBuiltinSkill(adapter.agentType);
}

export async function maybeInstallDaemons(opts: LocalAgentSetupOpts): Promise<void> {
	if (await shouldInstallDaemons(opts)) installDaemonsForRegisteredAgents();
}

function installDaemonsForRegisteredAgents() {
	const registered = listRegisteredAgentTypes();
	if (registered.length === 0) {
		console.log(chalk.gray("No registered agents available for daemon install."));
		return;
	}
	console.log();
	console.log(chalk.cyan("Installing background sync daemon..."));
	installDaemonForAllRegisteredAgents();
}

async function installBuiltinSkill(agentType: AgentType) {
	const targetDir = builtinSkillTargetDir(agentType);
	if (!targetDir) return;
	const label = adapterRegistry[agentType].displayName;

	const sourceDir = join(resolveCurrentCliResourceRoot(), "skills", "clawdi");
	if (!existsSync(sourceDir)) {
		console.log(chalk.yellow("⚠ Built-in skill not found, skipping."));
		return;
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
			throw new Error(`refusing to replace unmanaged Skill at ${targetDir}`);
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
	} catch (error) {
		console.log(chalk.yellow(`⚠ Could not install Clawdi skill (${errMessage(error)}).`));
	}
}
