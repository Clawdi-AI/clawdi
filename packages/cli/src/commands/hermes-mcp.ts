import { homedir } from "node:os";
import { getHermesHome } from "../adapters/paths";
import { discoverHermesProfiles, type LocalAgentProfile } from "../adapters/profiles";
import { resolveCurrentCliInvocation } from "../lib/current-cli-invocation";
import {
	beginHermesConfigTransactionAsync,
	commitHermesConfigTransaction,
	getHermesRawConfigValue,
	type HermesConfigCommandContext,
	HermesConfigCommandError,
	HermesConfigConflictError,
	HermesConfigInvalidError,
	HermesConfigReadError,
	reconcileHermesConfigValue,
} from "../runtime/hermes-config";
import { RuntimeUserCommandTimeoutError } from "../runtime/runtime-user-command";
import { log } from "../serve/log";

export type HermesMcpFailureReason =
	| "command_unavailable"
	| "command_failed"
	| "command_timeout"
	| "config_invalid"
	| "config_conflict";

function errorCode(error: unknown): string | number | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = error.code;
	return typeof code === "string" || typeof code === "number" ? code : undefined;
}

/** Reduce local reconcile failures to a stable, non-sensitive reason for daemon logs. */
export function classifyHermesMcpFailure(error: unknown): HermesMcpFailureReason {
	if (
		error instanceof RuntimeUserCommandTimeoutError ||
		errorCode(error) === "ETIMEDOUT" ||
		(typeof error === "object" &&
			error !== null &&
			"killed" in error &&
			error.killed === true &&
			"signal" in error &&
			error.signal === "SIGKILL")
	)
		return "command_timeout";
	if (error instanceof HermesConfigConflictError) return "config_conflict";
	if (error instanceof HermesConfigInvalidError || error instanceof HermesConfigReadError)
		return "config_invalid";
	const code = errorCode(error);
	const errno =
		typeof error === "object" && error !== null && "errno" in error
			? typeof error.errno === "string" || typeof error.errno === "number"
				? error.errno
				: undefined
			: undefined;
	if (
		code === 127 ||
		code === "ENOENT" ||
		code === "EACCES" ||
		errno === "ENOENT" ||
		errno === "EACCES"
	)
		return "command_unavailable";
	if (error instanceof HermesConfigCommandError && error.status === 127)
		return "command_unavailable";
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
		throw new HermesConfigInvalidError("Hermes config field mcp_servers must be an object");
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
		throw new HermesConfigConflictError();
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
