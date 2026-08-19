import { stripTerminalEscapes } from "../lib/sanitize";
import { RuntimeUserCommandTimeoutError, spawnRuntimeUserCommand } from "./runtime-user-command";

const HERMES_CONFIG_COMMAND_TIMEOUT_MS = 30_000;

export interface HermesConfigCommandContext {
	command: string;
	home: string;
	cwd: string;
	environment?: Record<string, string>;
}

export interface HermesConfigValue {
	exists: boolean;
	value?: unknown;
}

function commandText(value: string | Buffer | null | undefined): string {
	return stripTerminalEscapes(String(value ?? "")).trim();
}

function commandFailure(
	operation: string,
	result: ReturnType<typeof spawnRuntimeUserCommand>,
): Error {
	if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
		return new RuntimeUserCommandTimeoutError(operation, HERMES_CONFIG_COMMAND_TIMEOUT_MS);
	}
	const detail =
		commandText(result.stderr) || commandText(result.stdout) || commandText(result.error?.message);
	return new Error(`${operation} failed${detail ? `: ${detail}` : ""}`);
}

function runHermesConfigCommand(
	context: HermesConfigCommandContext,
	args: string[],
): ReturnType<typeof spawnRuntimeUserCommand> {
	return spawnRuntimeUserCommand(context.command, ["config", ...args], context.home, context.cwd, {
		environment: context.environment,
		timeoutMs: HERMES_CONFIG_COMMAND_TIMEOUT_MS,
	});
}

export function getHermesConfigValue(
	context: HermesConfigCommandContext,
	key: string,
): HermesConfigValue {
	const result = runHermesConfigCommand(context, ["get", key, "--json"]);
	if (result.status !== 0 || result.error) {
		const detail = `${commandText(result.stderr)}\n${commandText(result.stdout)}`;
		if (detail.includes(`Config key not set: ${key}`)) return { exists: false };
		throw commandFailure(`Hermes config get ${key}`, result);
	}
	const stdout = commandText(result.stdout);
	try {
		return { exists: true, value: JSON.parse(stdout) as unknown };
	} catch {
		throw new Error(`Hermes config get ${key} returned invalid JSON`);
	}
}

function configSetValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

export function setHermesConfigValue(
	context: HermesConfigCommandContext,
	key: string,
	value: unknown,
): void {
	const result = runHermesConfigCommand(context, ["set", "--force", key, configSetValue(value)]);
	if (result.status !== 0 || result.error) {
		throw commandFailure(`Hermes config set ${key}`, result);
	}
}

export function unsetHermesConfigValue(context: HermesConfigCommandContext, key: string): void {
	const result = runHermesConfigCommand(context, ["unset", key]);
	if (result.status !== 0 || result.error) {
		throw commandFailure(`Hermes config unset ${key}`, result);
	}
}

function canonicalJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJsonValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalJsonValue(entry)]),
	);
}

function configValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

export function reconcileHermesConfigValue(
	context: HermesConfigCommandContext,
	key: string,
	desired: unknown | undefined,
): boolean {
	const current = getHermesConfigValue(context, key);
	if (desired === undefined) {
		if (!current.exists) return false;
		unsetHermesConfigValue(context, key);
		return true;
	}
	if (current.exists && configValuesEqual(current.value, desired)) return false;
	setHermesConfigValue(context, key, desired);
	return true;
}
