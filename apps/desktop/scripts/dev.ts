import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const webRoot = resolve(desktopRoot, "../web");
const port = Number(process.env.CLAWDI_DESKTOP_DEV_PORT ?? "3210");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
	throw new Error("CLAWDI_DESKTOP_DEV_PORT must be an integer from 1024 to 65535");
}
const webUrl = `http://127.0.0.1:${port}`;
const children = new Set<ChildProcess>();
let stopping = false;

process.once("SIGINT", stopChildren);
process.once("SIGTERM", stopChildren);

try {
	if (!existsSync(join(desktopRoot, "resources", "native", "clawdi"))) {
		await runToCompletion("bun", ["run", "prepare:native"], desktopRoot);
	}
	await runToCompletion("bun", ["run", "build"], desktopRoot);
	const web = start(
		"bun",
		["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
		webRoot,
		{
			VITE_CLAWDI_HOSTED: "true",
			VITE_CLAWDI_API_URL: "https://cloud-api.clawdi.ai",
			VITE_CLAWDI_DEPLOY_API_URL: "https://api.clawdi.ai",
		},
	);
	await waitForWeb(webUrl, web);
	const electron = start("bun", ["x", "electron", "."], desktopRoot, {
		CLAWDI_DESKTOP_WEB_URL: webUrl,
	});
	process.exitCode = await childExit(electron);
} finally {
	stopChildren();
}

function start(
	command: string,
	args: string[],
	cwd: string,
	extraEnv: Record<string, string> = {},
): ChildProcess {
	const child = spawn(command, args, {
		cwd,
		env: { ...process.env, ...extraEnv },
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

async function waitForWeb(url: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("Web development server exited before startup");
		try {
			const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_000) });
			if (response.status > 0) return;
		} catch {
			// The server is still starting.
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
	}
	throw new Error("Timed out waiting for the Web development server");
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
