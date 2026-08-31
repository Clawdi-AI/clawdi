import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [executablePath, runtimeRoot, surface = "install"] = process.argv.slice(2);
if (!executablePath || !runtimeRoot || !["install", "dashboard"].includes(surface)) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root> [install|dashboard]");
}

const home = join(runtimeRoot, "home");
const clawdiHome = join(runtimeRoot, "state");
mkdirSync(home, { recursive: true });
mkdirSync(clawdiHome, { recursive: true });

const output = [];
const desktopArgs = [
	`--user-data-dir=${join(runtimeRoot, "electron-data")}`,
	"--remote-debugging-port=0",
];
const desktop = spawn(executablePath, desktopArgs, {
	env: {
		...process.env,
		HOME: home,
		CLAWDI_HOME: clawdiHome,
		CLAWDI_DESKTOP_SMOKE_LOG_FILE: join(runtimeRoot, "native-cli.log"),
		ELECTRON_ENABLE_LOGGING: "1",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
desktop.stdout.on("data", (chunk) => output.push(chunk.toString()));
desktop.stderr.on("data", (chunk) => output.push(chunk.toString()));

let browser;
let failure;
try {
	const endpoint = await waitForDevToolsEndpoint(desktop, output, 30_000);
	browser = await chromium.connectOverCDP(endpoint);
	const context = browser.contexts()[0];
	if (!context) throw new Error("Packaged app did not create a browser context.");
	if (surface === "dashboard") await verifyPackagedDashboard(context);
	else await verifyInstallGate(context, desktop, output);
} catch (error) {
	failure = error;
} finally {
	await browser?.close().catch(() => undefined);
	await stopProcess(desktop);
}
if (failure) {
	throw new Error(
		`${failure instanceof Error ? failure.message : String(failure)}\n${diagnostics(output, runtimeRoot)}`,
	);
}

async function verifyInstallGate(context, desktop, output) {
	const window = await waitForWindow(context, null, 30_000);
	const moveToApplications = window.getByRole("heading", {
		name: "Move Clawdi to Applications",
	});
	const failure = window.getByRole("heading", { name: "Couldn't finish setup" });
	await Promise.race([
		moveToApplications.waitFor({ state: "visible", timeout: 20_000 }),
		failure.waitFor({ state: "visible", timeout: 20_000 }).then(async () => {
			throw new Error(`Packaged setup failed:\n${await window.locator("body").innerText()}`);
		}),
	]);
	await window.close();
	await delay(500);
	assert.ok(
		desktop.exitCode === null && desktop.signalCode === null,
		`Desktop exited when Connect Agent closed.\n${output.join("")}`,
	);
}

async function verifyPackagedDashboard(context) {
	const window = await waitForWindow(context, "dashboard", 30_000);
	await window.getByRole("heading", { name: "Sign in to Clawdi" }).waitFor({ timeout: 20_000 });
	assert.equal(new URL(window.url()).origin, "https://cloud.clawdi.ai");
	const bridgeMethods = await window.evaluate(() => Object.keys(window.clawdiDesktop ?? {}).sort());
	assert.deepEqual(bridgeMethods, ["openConnectWizard", "retryDashboard", "signIn", "signOut"]);
}

async function waitForWindow(context, surface, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const window = context.pages().find((page) => {
			try {
				const url = new URL(page.url());
				if (surface === "dashboard") return url.origin === "https://cloud.clawdi.ai";
				return url.protocol === "clawdi-app:";
			} catch {
				return false;
			}
		});
		if (window) return window;
		await delay(100);
	}
	throw new Error(
		`Packaged app did not open the expected window. Pages: ${context
			.pages()
			.map((page) => page.url())
			.join(", ")}`,
	);
}

function diagnostics(output, runtimeRoot) {
	let cliLog = "<no CLI calls>";
	try {
		cliLog = readFileSync(join(runtimeRoot, "native-cli.log"), "utf8").trim() || cliLog;
	} catch {}
	return `Electron output:\n${output.join("")}\nCLI calls:\n${cliLog}`;
}

function waitForDevToolsEndpoint(child, logs, timeout) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => fail(new Error(`Timed out waiting for packaged app startup.\n${logs.join("")}`)),
			timeout,
		);
		const onData = () => {
			const match = logs.join("").match(/DevTools listening on (ws:\/\/\S+)/);
			if (match) finish(match[1]);
		};
		const onError = (error) => fail(error);
		const onExit = (code, signal) =>
			fail(
				new Error(
					`Packaged app exited before startup (code=${code}, signal=${signal}).\n${logs.join("")}`,
				),
			);

		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);

		function cleanup() {
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.stderr.off("data", onData);
			child.off("error", onError);
			child.off("exit", onExit);
		}
		function finish(endpoint) {
			cleanup();
			resolve(endpoint);
		}
		function fail(error) {
			cleanup();
			reject(error);
		}
	});
}

async function stopProcess(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	const exited = once(child, "exit").then(() => true);
	if (await Promise.race([exited, delay(5_000).then(() => false)])) return;
	child.kill("SIGKILL");
	await exited;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
