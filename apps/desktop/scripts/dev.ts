import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const children = new Set<ChildProcess>();
let stopping = false;

process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

try {
	if (!existsSync(join(desktopRoot, "resources", "native", "clawdi"))) {
		await runToCompletion("bun", ["run", "prepare:native"], desktopRoot);
	}
	await runToCompletion("bun", ["run", "build"], desktopRoot);
	const electron = start("bun", ["x", "electron", "."], desktopRoot);
	process.exitCode = await childExit(electron);
} finally {
	stopChildren();
}

function start(command: string, args: string[], cwd: string): ChildProcess {
	const child = spawn(command, args, {
		cwd,
		env: process.env,
		stdio: "inherit",
	});
	children.add(child);
	child.once("exit", () => children.delete(child));
	return child;
}

async function runToCompletion(command: string, args: string[], cwd: string): Promise<void> {
	const child = start(command, args, cwd);
	const code = await childExit(child);
	if (code !== 0) throw new Error(`${command} failed with exit ${code}`);
}

function childExit(child: ChildProcess): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
	});
}

function stopChildren(): void {
	if (stopping) return;
	stopping = true;
	for (const child of children) child.kill("SIGTERM");
}
