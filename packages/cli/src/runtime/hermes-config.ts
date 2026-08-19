import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
import { stripTerminalEscapes } from "../lib/sanitize";
import {
	RuntimeUserCommandTimeoutError,
	spawnRuntimeUserCommand,
	withRuntimeUserFileAccess,
} from "./runtime-user-command";

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

export function getHermesResolvedConfigValue(
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

function hermesConfigPath(context: HermesConfigCommandContext): string {
	const result = runHermesConfigCommand(context, ["path"]);
	if (result.status !== 0 || result.error) {
		throw commandFailure("Hermes config path", result);
	}
	const path = commandText(result.stdout);
	if (!isAbsolute(path)) throw new Error("Hermes config path returned a non-absolute path");
	return path;
}

function isConfigRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHermesConfigDocument(context: HermesConfigCommandContext): {
	path: string;
	document: ReturnType<typeof parseDocument>;
	root: Record<string, unknown>;
} {
	const path = hermesConfigPath(context);
	let content = "";
	try {
		content = withRuntimeUserFileAccess(() => readFileSync(path, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw new Error(
				`Hermes config could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const document = parseDocument(content);
	if (document.errors.length > 0) {
		throw new Error(`Hermes config is invalid YAML: ${document.errors[0]?.message}`);
	}
	const parsed = document.toJS() as unknown;
	if (parsed === null || parsed === undefined) return { path, document, root: {} };
	if (!isConfigRecord(parsed)) throw new Error("Hermes config must be an object");
	return { path, document, root: parsed };
}

export function getHermesRawConfigValue(
	context: HermesConfigCommandContext,
	key: string,
): HermesConfigValue {
	let current: unknown = readHermesConfigDocument(context).root;
	for (const part of key.split(".")) {
		if (!isConfigRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
		current = current[part];
	}
	return { exists: true, value: current };
}

function configValueAtPath(
	root: Record<string, unknown>,
	path: readonly string[],
): HermesConfigValue {
	let current: unknown = root;
	for (const part of path) {
		if (!isConfigRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
		current = current[part];
	}
	return { exists: true, value: current };
}

function setHermesStructuredConfigValue(
	context: HermesConfigCommandContext,
	key: string,
	value: object | null,
): void {
	const { path, document, root } = readHermesConfigDocument(context);
	const keyPath = key.split(".");
	for (let index = 1; index < keyPath.length; index += 1) {
		const parentPath = keyPath.slice(0, index);
		const parent = configValueAtPath(root, parentPath);
		if (!parent.exists) {
			document.setIn(parentPath, document.createNode({}));
			continue;
		}
		if (!isConfigRecord(parent.value)) {
			throw new Error(`Hermes config field ${parentPath.join(".")} must be an object`);
		}
	}
	document.setIn(keyPath, document.createNode(value));
	withRuntimeUserFileAccess(() =>
		writePrivateFileAtomic(path, String(document), {
			mode: PRIVATE_FILE_MODE,
			dirMode: PRIVATE_DIR_MODE,
		}),
	);
}

export function setHermesConfigValue(
	context: HermesConfigCommandContext,
	key: string,
	value: unknown,
): void {
	// Hermes config set does not reliably coerce structured CLI values across
	// supported installs, so mappings and arrays use its resolved config path
	// and an atomic YAML document update instead.
	if (typeof value === "object") {
		setHermesStructuredConfigValue(context, key, value);
		return;
	}
	const result = runHermesConfigCommand(context, ["set", "--force", key, String(value)]);
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
	const current = getHermesRawConfigValue(context, key);
	if (desired === undefined) {
		if (!current.exists) return false;
		unsetHermesConfigValue(context, key);
		return true;
	}
	if (current.exists && configValuesEqual(current.value, desired)) return false;
	setHermesConfigValue(context, key, desired);
	return true;
}
