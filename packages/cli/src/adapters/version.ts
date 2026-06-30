import { execFileSync } from "node:child_process";

const VERSION_COMMAND_TIMEOUT_MS = 1500;

export function readCommandVersion(command: string, args: string[]): string | null {
	try {
		const output = execFileSync(command, args, {
			encoding: "utf-8",
			stdio: "pipe",
			timeout: VERSION_COMMAND_TIMEOUT_MS,
			windowsHide: true,
		}).trim();
		return output.split("\n")[0] || null;
	} catch {
		return null;
	}
}
