import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { AgentAdapter } from "../adapters/base";
import {
	AGENT_TYPES,
	type AgentType,
	adapterRegistry,
	allAdapterEntries,
	getAdapterEntry,
} from "../adapters/registry";
import { getClawdiDir } from "./config";
import { askOne } from "./prompts";
import { isInteractive } from "./tty";

export function getEnvIdByAgent(agentType: string): string | null {
	const envPath = join(getClawdiDir(), "environments", `${agentType}.json`);
	if (!existsSync(envPath)) return null;
	return JSON.parse(readFileSync(envPath, "utf-8")).id;
}

export function adapterForType(agentType: AgentType): AgentAdapter | null {
	const entry = getAdapterEntry(agentType);
	return entry ? entry.create() : null;
}

export function listRegisteredAgentTypes(): AgentType[] {
	const envDir = join(getClawdiDir(), "environments");
	if (!existsSync(envDir)) return [];
	const types: AgentType[] = [];
	const files = new Set(readdirSync(envDir));
	for (const entry of allAdapterEntries()) {
		if (files.has(entry.envFileName)) types.push(entry.agentType);
	}
	return types;
}

/**
 * Resolve the agent adapter to operate on. Prints a specific error message
 * to stdout before returning null so callers can simply abort — distinguishing
 * "no agents found" from "ambiguous, can't pick without a prompt" is critical
 * in non-interactive contexts (CI, AI agents, piped stdout) where the user
 * sees a misleading "no supported agent" message if we collapse the cases.
 */
export async function selectAdapter(agentOpt?: string): Promise<AgentAdapter | null> {
	// 1. Explicit --agent wins.
	if (agentOpt) {
		if (!AGENT_TYPES.includes(agentOpt as AgentType)) {
			console.log(chalk.red(`Unknown agent type: ${agentOpt}`));
			console.log(chalk.gray(`Valid types: ${AGENT_TYPES.join(", ")}`));
			return null;
		}
		const adapter = adapterForType(agentOpt as AgentType);
		if (!adapter) {
			console.log(chalk.red(`Agent ${agentOpt} has no adapter implementation.`));
			return null;
		}
		return adapter;
	}

	// 2. Prefer registered environments.
	const registered = listRegisteredAgentTypes();
	if (registered.length === 1 && registered[0]) return adapterForType(registered[0]);
	if (registered.length > 1) {
		if (!isInteractive()) {
			console.log(chalk.red("Multiple agents are registered on this machine."));
			console.log(
				chalk.gray(`Pass --agent <type> to choose one. Registered: ${registered.join(", ")}`),
			);
			return null;
		}
		const picked = await askOne<AgentType>(
			"Multiple agents registered. Select one:",
			registered.map((t) => ({ value: t, label: adapterRegistry[t].displayName })),
		);
		return picked ? adapterForType(picked) : null;
	}

	// 3. Fall back to detection.
	const allAdapters = allAdapterEntries().map((e) => e.create());
	const detected = (
		await Promise.all(allAdapters.map(async (a) => ((await a.detect()) ? a : null)))
	).filter((a): a is AgentAdapter => a !== null);
	if (detected.length === 0) {
		console.log(chalk.red("No supported agent detected on this machine."));
		console.log(
			chalk.gray(`Install one or pass --agent <type>. Available types: ${AGENT_TYPES.join(", ")}`),
		);
		return null;
	}
	if (detected.length === 1 && detected[0]) return detected[0];
	if (!isInteractive()) {
		const types = detected.map((a) => a.agentType);
		console.log(chalk.red("Multiple agents detected on this machine."));
		console.log(chalk.gray(`Pass --agent <type> to choose one. Detected: ${types.join(", ")}`));
		return null;
	}
	const picked = await askOne<AgentType>(
		"Multiple agents detected. Select one:",
		detected.map((a) => ({
			value: a.agentType,
			label: adapterRegistry[a.agentType].displayName,
		})),
	);
	return picked ? adapterForType(picked) : null;
}
