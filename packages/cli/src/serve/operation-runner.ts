import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stripTerminalEscapes } from "../lib/sanitize";

const MAX_OUTPUT_LINES = 1000;
const MAX_OPERATIONS = 100;
const MAX_RUNNING_OPERATIONS = 4;
const DEFAULT_IMMEDIATE_TIMEOUT_MS = 60_000;

export type OperationStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface CommandResult {
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export interface OperationSnapshot {
	id: string;
	name: string;
	status: OperationStatus;
	exclusive_key?: string;
	command: string[];
	cwd: string;
	started_at: string;
	finished_at: string | null;
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string[];
	stderr: string[];
}

interface OperationRecord extends OperationSnapshot {
	child: ChildProcess;
}

export interface CommandOperationOptions {
	name: string;
	args: string[];
	cwd?: string;
	stdin?: string;
	redactedArgs?: string[];
	exclusiveKey?: string;
}

export interface ImmediateCommandOptions extends CommandOperationOptions {
	timeoutMs?: number;
}

class OperationManager {
	private operations = new Map<string, OperationRecord>();

	start(options: CommandOperationOptions): OperationSnapshot {
		this.assertCanStart(options);
		const invocation = buildCliInvocation(options.args);
		const cwd = resolveOperationCwd(options.cwd);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: nestedCliEnv(),
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const operation: OperationRecord = {
			id: randomUUID(),
			name: options.name,
			status: "running",
			exclusive_key: options.exclusiveKey,
			command: [invocation.command, ...(options.redactedArgs ?? invocation.args)],
			cwd,
			started_at: new Date().toISOString(),
			finished_at: null,
			exit_code: null,
			signal: null,
			stdout: [],
			stderr: [],
			child,
		};
		this.operations.set(operation.id, operation);
		this.prune();
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => appendLines(operation.stdout, chunk));
		child.stderr?.on("data", (chunk: string) => appendLines(operation.stderr, chunk));
		child.on("error", (error) => {
			appendLines(operation.stderr, error.message);
		});
		child.on("close", (code, signal) => {
			operation.exit_code = code;
			operation.signal = signal;
			operation.finished_at = new Date().toISOString();
			if (operation.status !== "cancelled") {
				operation.status = code === 0 ? "succeeded" : "failed";
			}
		});
		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		} else {
			child.stdin?.end();
		}
		return snapshotOperation(operation);
	}

	list(limit = 50): OperationSnapshot[] {
		return [...this.operations.values()].slice(-limit).reverse().map(snapshotOperation);
	}

	get(id: string): OperationSnapshot | null {
		const operation = this.operations.get(id);
		return operation ? snapshotOperation(operation) : null;
	}

	logs(id: string, limit = 200): { stdout: string[]; stderr: string[] } | null {
		const operation = this.operations.get(id);
		if (!operation) return null;
		return {
			stdout: tail(operation.stdout, limit),
			stderr: tail(operation.stderr, limit),
		};
	}

	cancel(id: string): OperationSnapshot | null {
		const operation = this.operations.get(id);
		if (!operation) return null;
		if (operation.status === "running") {
			operation.status = "cancelled";
			operation.finished_at = new Date().toISOString();
			terminateChild(operation.child);
		}
		return snapshotOperation(operation);
	}

	private assertCanStart(options: CommandOperationOptions): void {
		const running = [...this.operations.values()].filter(
			(operation) => operation.status === "running",
		);
		if (running.length >= MAX_RUNNING_OPERATIONS) {
			throw new Error(`Too many running daemon operations (max ${MAX_RUNNING_OPERATIONS}).`);
		}
		if (
			options.exclusiveKey &&
			running.some((operation) => operation.exclusive_key === options.exclusiveKey)
		) {
			throw new Error(`Another ${options.exclusiveKey} operation is already running.`);
		}
	}

	private prune(): void {
		let overflow = this.operations.size - MAX_OPERATIONS;
		if (overflow <= 0) return;
		for (const operation of this.operations.values()) {
			if (overflow <= 0) break;
			if (operation.status === "running") continue;
			this.operations.delete(operation.id);
			overflow -= 1;
		}
	}
}

export const operationManager = new OperationManager();

export async function runCliCommandImmediate(
	options: ImmediateCommandOptions,
): Promise<CommandResult> {
	const invocation = buildCliInvocation(options.args);
	const cwd = resolveOperationCwd(options.cwd);
	const timeoutMs = options.timeoutMs ?? DEFAULT_IMMEDIATE_TIMEOUT_MS;
	return await new Promise<CommandResult>((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			env: nestedCliEnv(),
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({
				...result,
				stdout: stripTerminalEscapes(result.stdout),
				stderr: stripTerminalEscapes(result.stderr),
			});
		};
		const timer = setTimeout(() => {
			terminateChild(child);
			finish({
				exit_code: null,
				signal: "SIGTERM",
				stdout,
				stderr: `${stderr}${stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms.`,
			});
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr += `${stderr ? "\n" : ""}${error.message}`;
		});
		child.on("close", (code, signal) => {
			finish({ exit_code: code, signal, stdout, stderr });
		});
		if (options.stdin !== undefined) {
			child.stdin?.end(options.stdin);
		} else {
			child.stdin?.end();
		}
	});
}

function snapshotOperation(operation: OperationRecord): OperationSnapshot {
	return {
		id: operation.id,
		name: operation.name,
		status: operation.status,
		exclusive_key: operation.exclusive_key,
		command: operation.command,
		cwd: operation.cwd,
		started_at: operation.started_at,
		finished_at: operation.finished_at,
		exit_code: operation.exit_code,
		signal: operation.signal,
		stdout: tail(operation.stdout, 200),
		stderr: tail(operation.stderr, 200),
	};
}

function appendLines(target: string[], chunk: string): void {
	for (const line of stripTerminalEscapes(chunk).split(/\r?\n/)) {
		if (!line) continue;
		target.push(line);
	}
	if (target.length > MAX_OUTPUT_LINES) {
		target.splice(0, target.length - MAX_OUTPUT_LINES);
	}
}

function tail(lines: string[], limit: number): string[] {
	return lines.slice(Math.max(0, lines.length - limit));
}

function buildCliInvocation(args: string[]): { command: string; args: string[] } {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot resolve the current clawdi CLI entrypoint for RPC operation.");
	}
	return {
		command: process.execPath,
		args: [entrypoint, ...args],
	};
}

function resolveOperationCwd(cwd: string | undefined): string {
	return resolve(cwd ?? process.cwd());
}

const NESTED_CLI_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TEMP",
	"TMP",
	"CI",
	"GITHUB_ACTIONS",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_API_URL",
	"CLAWDI_HOME",
	"CLAWDI_STATE_DIR",
	"CLAWDI_AGENT_TYPE",
	"CLAWDI_SERVE_MODE",
	"CLAWDI_SERVE_DEBUG",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"HERMES_HOME",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_AGENT_ID",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"BUN_INSTALL",
] as const;

function nestedCliEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		CLAWDI_NO_UPDATE_CHECK: "1",
		CLAWDI_NO_AUTO_UPDATE: "1",
	};
	for (const key of NESTED_CLI_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function terminateChild(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid) {
		try {
			process.kill(-child.pid, "SIGTERM");
			return;
		} catch {
			// Fall back to signalling the direct child.
		}
	}
	child.kill("SIGTERM");
}
