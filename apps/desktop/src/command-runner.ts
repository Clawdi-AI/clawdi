import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 60_000;
const FORCE_KILL_DELAY_MS = 2_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface CommandOptions {
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	stdin?: string;
	timeoutMs?: number;
}

export class CommandCancelledError extends Error {}

export function runCommand(
	command: string,
	args: readonly string[],
	opts: CommandOptions = {},
): Promise<CommandResult> {
	if (opts.signal?.aborted) {
		return Promise.reject(new CommandCancelledError("Clawdi sign-in was cancelled."));
	}

	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let terminationError: Error | null = null;
		let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

		const timeout = setTimeout(() => {
			terminate(new Error("Clawdi took too long to respond."), "SIGKILL");
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			opts.signal?.removeEventListener("abort", cancel);
			if (error) reject(error);
			else resolvePromise({ stdout, stderr });
		};

		function terminate(error: Error, signal: NodeJS.Signals): void {
			if (settled || terminationError) return;
			terminationError = error;
			child.kill(signal);
			if (signal !== "SIGKILL") {
				forceKillTimer = setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_DELAY_MS);
				forceKillTimer.unref();
			}
		}

		function cancel(): void {
			terminate(new CommandCancelledError("Clawdi sign-in was cancelled."), "SIGTERM");
		}

		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
				terminate(new Error("Clawdi produced too much output."), "SIGKILL");
				return current;
			}
			return next;
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.stdin.on("error", () => {});
		child.on("error", (error) => finish(error));
		child.on("exit", (code, signal) => {
			if (terminationError) {
				finish(terminationError);
				return;
			}
			if (code === 0) finish();
			else {
				const detail = stderr.trim().split("\n").at(-1) || `exit ${code ?? signal ?? "unknown"}`;
				finish(new Error(`Clawdi command failed: ${detail}`));
			}
		});
		opts.signal?.addEventListener("abort", cancel, { once: true });
		if (opts.signal?.aborted) cancel();
		child.stdin.end(opts.stdin ?? "");
	});
}
