import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseDocument } from "yaml";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writePrivateFileAtomic } from "../lib/private-file";
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

export interface HermesConfigTransaction {
	readonly context: HermesConfigCommandContext;
	readonly path: string;
	readonly sourceContent: string;
	readonly document: ReturnType<typeof parseDocument>;
	changed: boolean;
}

export type HermesConfigCommitResult = "unchanged" | "committed" | "conflict";

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

function readHermesConfigContentAtPath(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw new Error(
			`Hermes config could not be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function readHermesConfigDocumentAtPath(path: string): {
	path: string;
	content: string;
	document: ReturnType<typeof parseDocument>;
	root: Record<string, unknown>;
} {
	const content = readHermesConfigContentAtPath(path);
	const document = parseDocument(content);
	if (document.errors.length > 0) {
		throw new Error(`Hermes config is invalid YAML: ${document.errors[0]?.message}`);
	}
	const parsed = document.toJS() as unknown;
	if (parsed === null || parsed === undefined) return { path, content, document, root: {} };
	if (!isConfigRecord(parsed)) throw new Error("Hermes config must be an object");
	return { path, content, document, root: parsed };
}

export function beginHermesConfigTransaction(
	context: HermesConfigCommandContext,
): HermesConfigTransaction {
	const { path, content, document } = readHermesConfigDocumentAtPath(hermesConfigPath(context));
	return { context, path, sourceContent: content, document, changed: false };
}

function rawConfigValue(root: Record<string, unknown>, key: string): HermesConfigValue {
	let current: unknown = root;
	for (const part of key.split(".")) {
		if (!isConfigRecord(current) || !Object.hasOwn(current, part)) return { exists: false };
		current = current[part];
	}
	return { exists: true, value: current };
}

export function getHermesRawConfigValue(
	source: HermesConfigCommandContext | HermesConfigTransaction,
	key: string,
): HermesConfigValue {
	if ("document" in source) return rawConfigValue(configDocumentRoot(source.document), key);
	const transaction = beginHermesConfigTransaction(source);
	return rawConfigValue(configDocumentRoot(transaction.document), key);
}

export function getHermesRawConfigFileValue(path: string, key: string): HermesConfigValue {
	if (!isAbsolute(path)) throw new Error("Hermes config path must be absolute");
	return rawConfigValue(readHermesConfigDocumentAtPath(path).root, key);
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

function setHermesConfigValue(
	transaction: HermesConfigTransaction,
	key: string,
	value: unknown,
): void {
	const keyPath = key.split(".");
	for (let index = 1; index < keyPath.length; index += 1) {
		const parentPath = keyPath.slice(0, index);
		const parent = configValueAtPath(configDocumentRoot(transaction.document), parentPath);
		if (!parent.exists) {
			transaction.document.setIn(parentPath, transaction.document.createNode({}));
			continue;
		}
		if (!isConfigRecord(parent.value)) {
			throw new Error(`Hermes config field ${parentPath.join(".")} must be an object`);
		}
	}
	transaction.document.setIn(keyPath, transaction.document.createNode(value));
	transaction.changed = true;
}

function unsetHermesConfigValue(transaction: HermesConfigTransaction, key: string): void {
	const keyPath = key.split(".");
	transaction.document.deleteIn(keyPath);
	for (let length = keyPath.length - 1; length > 0; length -= 1) {
		const parentPath = keyPath.slice(0, length);
		const parent = configValueAtPath(configDocumentRoot(transaction.document), parentPath);
		if (!parent.exists || !isConfigRecord(parent.value) || Object.keys(parent.value).length > 0)
			break;
		transaction.document.deleteIn(parentPath);
	}
	transaction.changed = true;
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
	source: HermesConfigCommandContext | HermesConfigTransaction,
	key: string,
	desired: unknown | undefined,
): boolean {
	const transaction = "document" in source ? source : beginHermesConfigTransaction(source);
	const current = rawConfigValue(configDocumentRoot(transaction.document), key);
	if (desired === undefined) {
		if (!current.exists) return false;
		unsetHermesConfigValue(transaction, key);
		if (!("document" in source)) commitImmediateHermesConfigTransaction(transaction);
		return true;
	}
	if (current.exists && configValuesEqual(current.value, desired)) return false;
	setHermesConfigValue(transaction, key, desired);
	if (!("document" in source)) commitImmediateHermesConfigTransaction(transaction);
	return true;
}

function commitImmediateHermesConfigTransaction(transaction: HermesConfigTransaction): void {
	if (commitHermesConfigTransaction(transaction) === "conflict") {
		throw new Error("Hermes config changed during reconciliation");
	}
}

export function commitHermesConfigTransaction(
	transaction: HermesConfigTransaction,
): HermesConfigCommitResult {
	if (!transaction.changed) return "unchanged";
	if (readHermesConfigContentAtPath(transaction.path) !== transaction.sourceContent) {
		return "conflict";
	}
	writePrivateFileAtomic(transaction.path, String(transaction.document), {
		mode: PRIVATE_FILE_MODE,
		dirMode: PRIVATE_DIR_MODE,
	});
	transaction.changed = false;
	return "committed";
}

function configDocumentRoot(document: ReturnType<typeof parseDocument>): Record<string, unknown> {
	const parsed = document.toJS() as unknown;
	if (parsed === null || parsed === undefined) return {};
	if (!isConfigRecord(parsed)) throw new Error("Hermes config must be an object");
	return parsed;
}
