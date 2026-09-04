import { hostname } from "node:os";
import * as p from "@clack/prompts";
import type { components } from "@clawdi/shared/api";
import chalk from "chalk";
import { adapterModuleNames } from "../adapters/base";
import { AGENT_TYPES, type AgentType, adapterRegistry } from "../adapters/registry";
import { ApiClient, unwrap } from "../lib/api-client";
import { getAuth } from "../lib/config";
import { writeEnvironmentRegistration } from "../lib/environment-registration";
import { errMessage } from "../lib/errors";
import { getOrCreateMachineId, readMachineId } from "../lib/machine-identity";
import { getEnvIdByAgent } from "../lib/select-adapter";
import { isInteractive } from "../lib/tty";
import { type LocalAgentSetupOpts, maybeInstallDaemons, reconcileAgentIntegrations } from "./setup";

type AgentResponse = components["schemas"]["AgentResponse"];

interface AgentReconnectOpts extends LocalAgentSetupOpts {
	agent?: string;
	desktopList?: boolean;
	confirmTakeover?: boolean;
}

const DESKTOP_CANDIDATES_SCHEMA = "clawdi.agentReconnectCandidates.v1";

export async function agentReconnect(
	agentId: string | undefined,
	opts: AgentReconnectOpts,
): Promise<void> {
	const auth = getAuth();
	if (auth?.authType !== "clerk_oauth") {
		console.log(chalk.red("Reconnect requires Clerk OAuth. Run `clawdi auth login` first."));
		process.exitCode = 1;
		return;
	}

	const requestedType = parseAgentType(opts.agent);
	if (opts.agent && !requestedType) return;

	const api = new ApiClient();
	let agents: AgentResponse[];
	try {
		agents = unwrap(
			await api.GET("/v1/agents", {
				params: { query: { reconnectable: true } },
			}),
		);
	} catch (error) {
		console.log(chalk.red(`Could not list Agents: ${errMessage(error)}`));
		process.exitCode = 1;
		return;
	}
	if (opts.desktopList) {
		const currentMachineId = readMachineId();
		console.log(
			JSON.stringify({
				schemaVersion: DESKTOP_CANDIDATES_SCHEMA,
				agents: agents.flatMap((agent) => {
					const type = AGENT_TYPES.includes(agent.agent_type as AgentType)
						? (agent.agent_type as AgentType)
						: null;
					if (!type) return [];
					return [
						{
							id: agent.id,
							type,
							displayName: adapterRegistry[type].displayName,
							name: agent.name,
							machineName: agent.machine_name,
							isThisMachine: currentMachineId !== null && agent.machine_id === currentMachineId,
							lastSyncAt: agent.last_sync_at ?? null,
						},
					];
				}),
			}),
		);
		return;
	}

	const candidate = await selectCandidate(agents, agentId, requestedType);
	if (!candidate) return;
	const agentType = parseAgentType(candidate.agent_type);
	if (!agentType) return;
	if (requestedType && requestedType !== agentType) {
		console.log(chalk.red("The selected Agent does not match --agent."));
		process.exitCode = 1;
		return;
	}

	const currentRegistration = getEnvIdByAgent(agentType);
	if (currentRegistration && currentRegistration !== candidate.id) {
		console.log(
			chalk.red(
				`${adapterRegistry[agentType].displayName} is already connected locally. Run \`clawdi teardown --agent ${agentType}\` before reconnecting another identity.`,
			),
		);
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
	const recentOtherMachine =
		candidate.machine_id !== machineId && isRecentlySynced(candidate.last_sync_at);
	if (recentOtherMachine && opts.yes && !opts.confirmTakeover) {
		console.log(
			chalk.red(
				"This Agent recently synced from another machine. Repeat with --confirm-takeover to disconnect it explicitly.",
			),
		);
		process.exitCode = 1;
		return;
	}
	if (!opts.yes && !isInteractive()) {
		console.log(chalk.red("Non-interactive reconnect requires explicit confirmation with --yes."));
		process.exitCode = 1;
		return;
	}

	const adapter = adapterRegistry[agentType].create();
	let agentVersion: string | null;
	try {
		if (!(await adapter.detect())) {
			console.log(
				chalk.red(`${adapterRegistry[agentType].displayName} is not available on this machine.`),
			);
			process.exitCode = 1;
			return;
		}
		agentVersion = await adapter.getVersion();
	} catch (error) {
		console.log(
			chalk.red(
				`Could not inspect ${adapterRegistry[agentType].displayName}: ${errMessage(error)}`,
			),
		);
		process.exitCode = 1;
		return;
	}

	if (!opts.yes && isInteractive()) {
		const confirmed = await p.confirm({
			message: recentOtherMachine
				? `Take over “${candidate.name}” from the recently active machine “${candidate.machine_name}”? Its daemon will be fenced immediately.`
				: `Reconnect ${adapterRegistry[agentType].displayName} to “${candidate.name}” and replace its previous installation binding?`,
			initialValue: true,
		});
		if (p.isCancel(confirmed) || !confirmed) {
			p.cancel("Cancelled.");
			return;
		}
	}

	let rebound: components["schemas"]["EnvironmentCreatedResponse"];
	try {
		rebound = unwrap(
			await new ApiClient({ machineId }).POST("/v1/agents/{agent_id}/rebind", {
				params: { path: { agent_id: candidate.id } },
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
	} catch (error) {
		console.log(
			chalk.red(
				`Could not reconnect ${adapterRegistry[agentType].displayName}: ${errMessage(error)}`,
			),
		);
		process.exitCode = 1;
		return;
	}

	try {
		writeEnvironmentRegistration({
			id: rebound.id,
			agentType,
			machineId,
			machineName,
			userId: auth.userId,
		});
	} catch (error) {
		console.log(
			chalk.yellow(
				`⚠ Agent was rebound in Clawdi, but local state could not be saved: ${errMessage(error)}`,
			),
		);
		console.log(chalk.gray("  Fix local permissions, then run the same reconnect command again."));
		process.exitCode = 1;
		return;
	}

	console.log(chalk.green(`✓ ${adapterRegistry[agentType].displayName} reconnected`));
	try {
		await reconcileAgentIntegrations(adapter);
	} catch (error) {
		console.log(
			chalk.yellow(
				`⚠ Agent identity recovered, but local integration setup failed: ${errMessage(error)}`,
			),
		);
		process.exitCode = 1;
	}
	try {
		await maybeInstallDaemons(opts);
	} catch (error) {
		console.log(
			chalk.yellow(`⚠ Agent identity recovered, but daemon setup failed: ${errMessage(error)}`),
		);
		process.exitCode = 1;
	}
}

function isRecentlySynced(value: string | null | undefined): boolean {
	if (!value) return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && Date.now() - timestamp < 5 * 60_000;
}

function parseAgentType(value: string | undefined): AgentType | null {
	if (!value) return null;
	if (AGENT_TYPES.includes(value as AgentType)) return value as AgentType;
	console.log(chalk.red(`Unknown agent type: ${value}`));
	console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
	process.exitCode = 1;
	return null;
}

async function selectCandidate(
	agents: AgentResponse[],
	agentId: string | undefined,
	agentType: AgentType | null,
): Promise<AgentResponse | null> {
	if (agentId) {
		const candidate = agents.find((agent) => agent.id === agentId);
		if (candidate) return candidate;
		console.log(chalk.red("The selected Agent is unavailable or cannot be locally reconnected."));
		process.exitCode = 1;
		return null;
	}
	const reconnectable = agents.filter((agent) => !agentType || agent.agent_type === agentType);
	if (reconnectable.length === 0) {
		console.log(chalk.red("No reconnectable Agents were found for this account."));
		process.exitCode = 1;
		return null;
	}
	if (reconnectable.length === 1) return reconnectable[0] ?? null;
	if (!isInteractive()) {
		console.log(chalk.red("Multiple Agents match. Pass an Agent id to choose one."));
		process.exitCode = 1;
		return null;
	}
	const selected = await p.select<string>({
		message: "Reconnect which Agent?",
		options: reconnectable.map((agent) => {
			const type = AGENT_TYPES.includes(agent.agent_type as AgentType)
				? (agent.agent_type as AgentType)
				: null;
			return {
				value: agent.id,
				label: `${type ? adapterRegistry[type].displayName : agent.agent_type} — ${agent.name}`,
				hint: `${agent.machine_name} · ${agent.id}`,
			};
		}),
	});
	if (p.isCancel(selected)) {
		p.cancel("Cancelled.");
		return null;
	}
	return reconnectable.find((agent) => agent.id === selected) ?? null;
}
