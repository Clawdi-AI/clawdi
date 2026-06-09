import { existsSync, readFileSync } from "node:fs";
import { detectRuntimeMode, getRuntimePaths, type RuntimeMode } from "./paths";

export interface DeniedCommand {
	command: string;
	reason?: string;
}

export interface HostPolicy {
	schemaVersion?: string;
	mode?: string;
	cliUpdateMode?: string;
	immutableShim?: boolean;
	deniedCommands?: Array<string | DeniedCommand>;
	managedState?: string[];
	writableState?: string[];
	systemWritableState?: string[];
	userWritableState?: string[];
	ordinaryUserDeniedState?: string[];
}

export interface HostPolicyReadResult {
	path: string;
	exists: boolean;
	valid: boolean;
	policy?: HostPolicy;
	error?: string;
}

export interface HostPolicyCommandDecision {
	allowed: boolean;
	command: string;
	runtimeMode: RuntimeMode;
	policyPath?: string;
	reason?: string;
}

const POLICY_RECOVERY_COMMANDS = [
	"runtime",
	"capabilities",
	"auth status",
	"config paths",
	"status",
	"doctor",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseDeniedCommands(value: unknown): Array<string | DeniedCommand> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("deniedCommands must be an array");
	return value.map((item) => {
		if (typeof item === "string") return item;
		if (!isRecord(item) || typeof item.command !== "string") {
			throw new Error("deniedCommands entries must be strings or { command, reason } objects");
		}
		const reason = typeof item.reason === "string" ? item.reason : undefined;
		return reason ? { command: item.command, reason } : { command: item.command };
	});
}

export function readHostPolicy(path = getRuntimePaths().hostPolicy): HostPolicyReadResult {
	if (!existsSync(path)) return { path, exists: false, valid: false };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isRecord(parsed)) throw new Error("policy root must be an object");

		const policy: HostPolicy = {};
		if (typeof parsed.schemaVersion === "string") policy.schemaVersion = parsed.schemaVersion;
		if (typeof parsed.mode === "string") policy.mode = parsed.mode;
		if (typeof parsed.cliUpdateMode === "string") policy.cliUpdateMode = parsed.cliUpdateMode;
		if (typeof parsed.immutableShim === "boolean") policy.immutableShim = parsed.immutableShim;
		policy.deniedCommands = parseDeniedCommands(parsed.deniedCommands);
		if (parsed.managedState !== undefined) {
			if (!isStringArray(parsed.managedState))
				throw new Error("managedState must be a string array");
			policy.managedState = parsed.managedState;
		}
		if (parsed.writableState !== undefined) {
			if (!isStringArray(parsed.writableState))
				throw new Error("writableState must be a string array");
			policy.writableState = parsed.writableState;
		}
		if (parsed.systemWritableState !== undefined) {
			if (!isStringArray(parsed.systemWritableState))
				throw new Error("systemWritableState must be a string array");
			policy.systemWritableState = parsed.systemWritableState;
		}
		if (parsed.userWritableState !== undefined) {
			if (!isStringArray(parsed.userWritableState))
				throw new Error("userWritableState must be a string array");
			policy.userWritableState = parsed.userWritableState;
		}
		if (parsed.ordinaryUserDeniedState !== undefined) {
			if (!isStringArray(parsed.ordinaryUserDeniedState))
				throw new Error("ordinaryUserDeniedState must be a string array");
			policy.ordinaryUserDeniedState = parsed.ordinaryUserDeniedState;
		}

		return { path, exists: true, valid: true, policy };
	} catch (e) {
		return {
			path,
			exists: true,
			valid: false,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

export function normalizeDeniedCommands(policy?: HostPolicy): DeniedCommand[] {
	return (policy?.deniedCommands ?? []).map((entry) => {
		if (typeof entry === "string") return { command: entry };
		return entry;
	});
}

export function deniedCommandReason(
	policy: HostPolicy | undefined,
	command: string,
): string | null {
	const normalized = command.trim().replace(/\s+/g, " ");
	for (const entry of normalizeDeniedCommands(policy)) {
		const denied = entry.command.trim().replace(/\s+/g, " ");
		if (normalized === denied || normalized.startsWith(`${denied} `)) {
			return entry.reason ?? "disabled by hosted runtime policy";
		}
	}
	return null;
}

function commandMatches(command: string, prefix: string): boolean {
	return command === prefix || command.startsWith(`${prefix} `);
}

function isPolicyRecoveryCommand(command: string): boolean {
	return POLICY_RECOVERY_COMMANDS.some((allowed) => commandMatches(command, allowed));
}

export function evaluateHostPolicyForCommand(command: string): HostPolicyCommandDecision {
	const normalized = command.trim().replace(/\s+/g, " ");
	const runtimeMode = detectRuntimeMode();
	if (runtimeMode !== "hosted") return { allowed: true, command: normalized, runtimeMode };

	const policy = readHostPolicy();
	if (!policy.exists) {
		if (isPolicyRecoveryCommand(normalized)) {
			return { allowed: true, command: normalized, runtimeMode, policyPath: policy.path };
		}
		return {
			allowed: false,
			command: normalized,
			runtimeMode,
			policyPath: policy.path,
			reason: `missing hosted runtime policy at ${policy.path}`,
		};
	}

	if (!policy.valid) {
		if (isPolicyRecoveryCommand(normalized)) {
			return { allowed: true, command: normalized, runtimeMode, policyPath: policy.path };
		}
		return {
			allowed: false,
			command: normalized,
			runtimeMode,
			policyPath: policy.path,
			reason: `invalid hosted runtime policy at ${policy.path}: ${policy.error ?? "parse failed"}`,
		};
	}

	const reason = deniedCommandReason(policy.policy, normalized);
	if (reason) {
		return {
			allowed: false,
			command: normalized,
			runtimeMode,
			policyPath: policy.path,
			reason,
		};
	}

	return { allowed: true, command: normalized, runtimeMode, policyPath: policy.path };
}
