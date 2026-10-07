import { homedir } from "node:os";
import { getHermesHome } from "../adapters/paths";
import { discoverHermesProfiles, type LocalAgentProfile } from "../adapters/profiles";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import {
	beginHermesConfigTransactionAsync,
	commitHermesConfigTransaction,
	getHermesRawConfigValue,
	type HermesConfigCommandContext,
	reconcileHermesConfigValue,
} from "../runtime/hermes-config";
import { RuntimeUserCommandTimeoutError } from "../runtime/runtime-user-command";
import { log } from "../serve/log";

export type HermesMcpFailureReason =
	| "command_unavailable"
	| "command_failed"
	| "command_timeout"
	| "config_invalid"
	| "config_conflict"
	| "cli_unresolved";

function errorCode(error: unknown): string | number | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/** Reduce local reconcile failures to a stable, non-sensitive reason for daemon logs. */
export function classifyHermesMcpFailure(error: unknown): HermesMcpFailureReason {
	if (error instanceof RuntimeUserCommandTimeoutError || errorCode(error) === "ETIMEDOUT")
		return "command_timeout";
	const code = errorCode(error);
	const message = error instanceof Error ? error.message : String(error);
	if (
		message.includes("could not resolve the current clawdi CLI script") ||
		message.includes("could not resolve CLI executable path") ||
		message.includes("could not resolve CLI script path") ||
		message.includes("refusing to invoke a relative CLI") ||
		message.includes("could not resolve the clawdi package resource root")
	)
		return "cli_unresolved";
	if (
		code === 127 ||
		code === "ENOENT" ||
		code === "EACCES" ||
		message.includes("ENOENT") ||
		message.includes("No such file or directory") ||
		message.includes("command not found")
	)
		return "command_unavailable";
	if (message.includes("changed during reconciliation")) return "config_conflict";
	if (
		message.includes("invalid YAML") ||
		message.includes("must be an object") ||
		message.includes("returned invalid JSON") ||
		message.includes("non-absolute path")
	)
		return "config_invalid";
	return "command_failed";
}

function localHermesConfigContext(profile?: string): HermesConfigCommandContext {
	const home = process.env.HOME?.trim() || homedir();
	return {
		command: "hermes",
		...(profile ? { profile } : {}),
		home,
		cwd: process.cwd(),
		environment: { HERMES_HOME: getHermesHome(), HERMES_PROFILE: "", HERMES_PROFILE_NAME: "" },
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
	let profiles: LocalAgentProfile[];
	try {
		profiles = await discoverHermesProfiles();
	} catch {
		profiles = [{ profileKey: "", upstreamKey: "default", isDefault: true, previousNames: [] }];
	}
	let changed = false;
	for (const profile of profiles) {
		try {
			changed =
				(await reconcileLocalHermesMcp(
					enabled,
					profile.isDefault ? undefined : profile.upstreamKey,
				)) || changed;
		} catch (error) {
			if (profile.isDefault) throw error;
			log.warn("profiles.mcp_failed", {
				profile_key: profile.profileKey,
				reason: classifyHermesMcpFailure(error),
			});
		}
	}
	return changed;
}
