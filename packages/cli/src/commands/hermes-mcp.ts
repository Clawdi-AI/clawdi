import { homedir } from "node:os";
import { getHermesHome } from "../adapters/paths";
import { discoverHermesProfiles } from "../adapters/profiles";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import {
	getHermesRawConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "../runtime/hermes-config";

function localHermesConfigContext(profile?: string): HermesConfigCommandContext {
	const home = process.env.HOME?.trim() || homedir();
	return {
		command: "hermes",
		...(profile ? { profile } : {}),
		home,
		cwd: process.cwd(),
		environment: { HERMES_HOME: getHermesHome() },
	};
}

export function reconcileLocalHermesMcp(enabled: boolean, profile?: string): boolean {
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
	const context = localHermesConfigContext(profile);
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
	if (enabled) next.clawdi = { command, args: [...args] };
	else delete next.clawdi;
	return reconcileHermesConfigValue(
		context,
		"mcp_servers",
		Object.keys(next).length > 0 ? next : undefined,
	);
}

export function reconcileAllLocalHermesMcp(enabled: boolean): boolean {
	let names: string[];
	try {
		names = discoverHermesProfiles().map((profile) => profile.upstreamKey);
	} catch {
		names = ["default"];
	}
	let changed = false;
	for (const name of names) changed = reconcileLocalHermesMcp(enabled, name) || changed;
	return changed;
}
