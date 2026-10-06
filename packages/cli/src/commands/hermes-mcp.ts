import { homedir } from "node:os";
import { getHermesHome } from "../adapters/paths";
import { discoverHermesProfiles } from "../adapters/profiles";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import {
	beginHermesConfigTransactionAsync,
	commitHermesConfigTransaction,
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

export async function reconcileLocalHermesMcp(
	enabled: boolean,
	profile?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
	const context = localHermesConfigContext(profile);
	const transaction = await beginHermesConfigTransactionAsync(context, signal);
	const current = getHermesRawConfigValue(transaction, "mcp_servers");
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
	const changed = reconcileHermesConfigValue(
		transaction,
		"mcp_servers",
		Object.keys(next).length > 0 ? next : undefined,
	);
	if (commitHermesConfigTransaction(transaction) === "conflict")
		throw new Error("Hermes config changed during reconciliation");
	return changed;
}

export async function reconcileAllLocalHermesMcp(enabled: boolean): Promise<boolean> {
	let names: string[];
	try {
		names = (await discoverHermesProfiles()).map((profile) => profile.upstreamKey);
	} catch {
		names = ["default"];
	}
	let changed = false;
	for (const name of names) changed = (await reconcileLocalHermesMcp(enabled, name)) || changed;
	return changed;
}
