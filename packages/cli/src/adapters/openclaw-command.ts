import { type ExecFileOptions, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let commandTail: Promise<void> = Promise.resolve();

export function runOpenClawCommand(
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer" | "signal">,
): Promise<string> {
	// Session reads and async Skill discovery share a subprocess slot, not the event loop.
	const command = commandTail.then(async () => {
		options.signal?.throwIfAborted();
		const { signal, ...limits } = options;
		const running = execFileAsync("openclaw", args, {
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
