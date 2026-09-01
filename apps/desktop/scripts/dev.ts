import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");

if (!existsSync(join(desktopRoot, "resources", "native", "clawdi"))) {
	await runToCompletion("bun", ["run", "prepare:native"]);
}
await runToCompletion("bun", ["run", "build"]);
const electron = spawn("bun", ["x", "electron", "."], {
	cwd: desktopRoot,
	env: process.env,
	stdio: "inherit",
});
process.exitCode = await childExit(electron);

async function runToCompletion(command: string, args: string[]): Promise<void> {
	const child = spawn(command, args, { cwd: desktopRoot, env: process.env, stdio: "inherit" });
	const code = await childExit(child);
	if (code !== 0) throw new Error(`${command} failed with exit ${code}`);
}

function childExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
	});
}
