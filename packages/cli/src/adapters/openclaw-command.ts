import { type ExecFileOptions, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let commandTail: Promise<void> = Promise.resolve();

export function runOpenClawCommand(
	args: string[],
	options: Pick<ExecFileOptions, "timeout" | "maxBuffer">,
): Promise<string> {
	// Session reads and async Skill discovery share a subprocess slot, not the event loop.
	const command = commandTail.then(async () => {
		const { stdout } = await execFileAsync("openclaw", args, {
			...options,
			encoding: "utf8",
			env: process.env,
		});
		return stdout;
	});
	commandTail = command.then(
		() => {},
		() => {},
	);
	return command;
}
