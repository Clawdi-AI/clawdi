import { type ExecFileOptions, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let commandTail: Promise<void> = Promise.resolve();

export function runOpenClawCommand(
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	return runOpenClawSubprocess("openclaw", args, options);
}

export function runOpenClawSdkCommand(
	sdkPath: string,
	params: { agentId: string; sessionId: string; sessionKey: string },
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	const source = `
		import { pathToFileURL } from 'node:url';
		const sdk = await import(pathToFileURL(process.argv[1]).href);
		const read = sdk.readVisibleSessionTranscriptMessageEntries;
		if (typeof read !== 'function') process.exit(2);
		const entries = await read(JSON.parse(process.argv[2]));
		process.stdout.write(JSON.stringify(entries));
	`;
	// This API returns a whole array. Keep its allocation outside the daemon heap.
	return runOpenClawSubprocess(
		"node",
		[
			"--max-old-space-size=64",
			"--input-type=module",
			"-e",
			source,
			sdkPath,
			JSON.stringify(params),
		],
		options,
	);
}

function runOpenClawSubprocess(
	executable: string,
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	// Session reads and async Skill discovery share a subprocess slot, not the event loop.
	const command = commandTail.then(async () => {
		options.signal?.throwIfAborted();
		const { signal, ...limits } = options;
		const running = execFileAsync(executable, args, {
			...limits,
			killSignal: "SIGKILL",
			encoding: "utf8",
			env: process.env,
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
	commandTail = command.then(
		() => {},
		() => {},
	);
	return command;
}
