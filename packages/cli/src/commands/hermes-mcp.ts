import { homedir } from "node:os";
import { getHermesHome } from "../adapters/paths";
import {
	getHermesRawConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "../runtime/hermes-config";

const CLAWDI_HERMES_MCP_SERVER = {
	command: "clawdi",
	args: ["mcp"],
};

function localHermesConfigContext(): HermesConfigCommandContext {
	const home = process.env.HOME?.trim() || homedir();
	return {
		command: "hermes",
		home,
		cwd: process.cwd(),
		environment: { HERMES_HOME: getHermesHome() },
	};
}

export function reconcileLocalHermesMcp(enabled: boolean): boolean {
	const context = localHermesConfigContext();
	const current = getHermesRawConfigValue(context, "mcp_servers");
	if (
		current.exists &&
		(typeof current.value !== "object" || current.value === null || Array.isArray(current.value))
	) {
		throw new Error("Hermes config field mcp_servers must be an object");
	}
	const next: Record<string, unknown> = current.exists
		? { ...(current.value as Record<string, unknown>) }
		: {};
	delete next["clawdi-mcp"];
	if (enabled) next.clawdi = CLAWDI_HERMES_MCP_SERVER;
	else delete next.clawdi;
	return reconcileHermesConfigValue(
		context,
		"mcp_servers",
		Object.keys(next).length > 0 ? next : undefined,
	);
}
