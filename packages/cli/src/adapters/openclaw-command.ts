import { type ExecFileOptions, execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { installedOpenClawCommandPath } from "../runtime/hosted-openclaw-context";
import { resolveRuntimeUserCommand } from "../runtime/runtime-user-command";

const execFileAsync = promisify(execFile);
let commandTail: Promise<void> = Promise.resolve();

function inheritedOpenClawEnvironment(): Readonly<Record<string, string | undefined>> {
	return {
		OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
		OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
	};
}

export class OpenClawSdkExitError extends Error {
	constructor(
		readonly code: number | null,
		readonly signal: NodeJS.Signals | null,
	) {
		super("OpenClaw transcript SDK subprocess failed");
	}
}

export function runOpenClawCommand(
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	return runOpenClawSubprocess(args, options);
}

export function resolveOpenClawCommandPath(home = process.env.HOME ?? homedir()): string {
	const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
	const executable =
		runtimeUser && runtimeUser !== "root" ? installedOpenClawCommandPath(home) : "openclaw";
	if (!executable) throw new Error("installed OpenClaw CLI is unavailable");
	return executable;
}

export function runOpenClawSdkCommand(
	sdkPath: string,
	params: { agentId: string; sessionId: string; sessionKey: string },
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	const source = `
		import { writeFileSync } from 'node:fs';
		import { pathToFileURL } from 'node:url';
		const sdk = await import(pathToFileURL(process.argv[1]).href);
		const read = sdk.readVisibleSessionTranscriptMessageEntries;
		if (typeof read !== 'function') process.exit(2);
		const entries = await read(JSON.parse(process.argv[2]));
		writeFileSync(3, JSON.stringify(entries));
	`;
	// This API returns a whole array. Keep its allocation outside the daemon heap.
	return enqueueOpenClawCommand(
		() =>
			new Promise<string>((resolve, reject) => {
				options.signal?.throwIfAborted();
				const runtimeUser = process.env.CLAWDI_RUNTIME_USER?.trim();
				const child = resolveRuntimeUserCommand(
					runtimeUser && runtimeUser !== "root" ? process.execPath : "node",
					[
						"--max-old-space-size=256",
						"--input-type=module",
						"-e",
						source,
						sdkPath,
						JSON.stringify(params),
					],
					process.env.HOME ?? homedir(),
					{ environmentOverrides: inheritedOpenClawEnvironment() },
				);
				const running = spawn(child.command, child.args, {
					stdio: ["ignore", "ignore", "ignore", "pipe"],
					env: child.env,
				});
				const result = running.stdio[3];
				const chunks: Buffer[] = [];
				let bytes = 0;
				let failure: Error | undefined;
				const fail = (error: Error) => {
					failure ??= error;
					running.kill("SIGKILL");
				};
				const abort = () => running.kill("SIGKILL");
				const timer = options.timeout
					? setTimeout(() => fail(new Error("OpenClaw transcript SDK timed out")), options.timeout)
					: undefined;
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) abort();
				if (result instanceof Readable) {
					result.on("data", (chunk: Buffer) => {
						if (failure) return;
						bytes += chunk.length;
						if (bytes > (options.maxBuffer ?? 1024 * 1024)) {
							fail(new Error("OpenClaw transcript SDK result exceeds buffer limit"));
							return;
						}
						chunks.push(chunk);
					});
					result.on("error", fail);
				} else fail(new Error("OpenClaw transcript SDK result pipe unavailable"));
				running.on("error", fail);
				running.once("close", (code, signal) => {
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", abort);
					try {
						options.signal?.throwIfAborted();
						if (failure) throw failure;
						if (code !== 0) throw new OpenClawSdkExitError(code, signal);
						resolve(Buffer.concat(chunks).toString("utf8"));
					} catch (error) {
						reject(error);
					}
				});
			}),
	);
}

function runOpenClawSubprocess(
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	// Session reads and async Skill discovery share a subprocess slot, not the event loop.
	return enqueueOpenClawCommand(async () => {
		options.signal?.throwIfAborted();
		const { signal, ...limits } = options;
		const home = process.env.HOME ?? homedir();
		const child = resolveRuntimeUserCommand(resolveOpenClawCommandPath(home), args, home, {
			environmentOverrides: inheritedOpenClawEnvironment(),
		});
		const running = execFileAsync(child.command, child.args, {
			...limits,
			killSignal: "SIGKILL",
			encoding: "utf8",
			env: child.env,
		});
		const closed = new Promise<void>((resolve) => running.child.once("close", () => resolve()));
		const abort = () => {
			running.child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			const { stdout } = await running;
			signal?.throwIfAborted();
			return stdout;
		} finally {
			signal?.removeEventListener("abort", abort);
			await closed;
		}
	});
}

function enqueueOpenClawCommand(read: () => Promise<string>): Promise<string> {
	const command = commandTail.then(read);
	commandTail = command.then(
		() => {},
		() => {},
	);
	return command;
}
