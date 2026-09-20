import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [executablePath, runtimeRoot, surface = "install"] = process.argv.slice(2);
const smokeAgentId = "00000000-0000-4000-8000-000000000001";
if (!executablePath || !runtimeRoot || !["install", "welcome", "remote"].includes(surface)) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root> [install|welcome|remote]");
}

const home = join(runtimeRoot, "home");
const clawdiHome = join(runtimeRoot, "state");
const localAppData =
	process.env.CLAWDI_DESKTOP_SMOKE_LOCAL_APP_DATA ?? join(runtimeRoot, "local-app-data");
const cliLog = join(runtimeRoot, "native-cli.log");
mkdirSync(home, { recursive: true });
mkdirSync(clawdiHome, { recursive: true });
mkdirSync(localAppData, { recursive: true });

const output = [];
const desktop = spawn(
	executablePath,
	[
		`--user-data-dir=${join(runtimeRoot, "electron-data")}`,
		"--remote-debugging-port=0",
		// Match Playwright's Chromium defaults: no OS keychain prompts in unattended tests.
		"--use-mock-keychain",
	],
	{
		env: {
			...process.env,
			HOME: home,
			CLAWDI_HOME: clawdiHome,
			LOCALAPPDATA: localAppData,
			CLAWDI_DESKTOP_SMOKE_SURFACE: surface,
			CLAWDI_DESKTOP_SMOKE_LOG_FILE: cliLog,
			ELECTRON_ENABLE_LOGGING: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
desktop.stdout.on("data", (chunk) => output.push(chunk.toString()));
desktop.stderr.on("data", (chunk) => output.push(chunk.toString()));

let browser;
let failure;
try {
	const endpoint = await waitForDevToolsEndpoint(desktop, output, 30_000);
	browser = await chromium.connectOverCDP(endpoint);
	const context = browser.contexts()[0];
	if (!context) throw new Error("Packaged app did not create a browser context.");
	if (surface === "remote") {
		const window = await waitForWindow(context, "dashboard", 30_000);
		await window
			.getByRole("heading", { name: "Desktop sign-in expired" })
			.waitFor({ timeout: 30_000 });
		const remote = await window.evaluate(async () => {
			const response = await fetch("/assets/not-packaged.js", { cache: "no-store" });
			return {
				version: window.clawdiDesktop?.apiVersion,
				contentType: response.headers.get("content-type"),
			};
		});
		assert.equal(remote.version, 1);
		assert.ok(remote.contentType, "Dashboard did not reach the remote web server.");
		await verifyDashboardBridge(context, window);
	} else if (surface === "welcome") {
		const window = await waitForWindow(context, null, 30_000);
		await window.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor({ timeout: 30_000 });
		await verifyAutomaticCliCommand();
	} else await verifyInstallGate(context, desktop, output, cliLog);
} catch (error) {
	failure = error;
} finally {
	await browser?.close().catch(() => undefined);
	await stopProcess(desktop);
}

async function verifyAutomaticCliCommand() {
	const launcher =
		process.platform === "win32"
			? join(localAppData, "Clawdi", "bin", "clawdi.cmd")
			: join(home, ".local", "bin", "clawdi");
	const deadline = Date.now() + 10_000;
	while (!existsSync(launcher) && Date.now() < deadline) await delay(100);
	assert.ok(existsSync(launcher), `Desktop did not install its CLI command at ${launcher}.`);
	if (process.platform === "win32") {
		assert.match(readFileSync(launcher, "utf8"), /Clawdi Desktop CLI launcher v1/);
		return;
	}
	assert.equal(lstatSync(launcher).isSymbolicLink(), true);
	assert.equal(existsSync(resolve(dirname(launcher), readlinkSync(launcher))), true);
}
if (failure) {
	throw new Error(
		`${failure instanceof Error ? failure.message : String(failure)}\n${diagnostics(output, cliLog)}`,
	);
}

async function verifyInstallGate(context, desktop, output, cliLog) {
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
	assert.equal(existsSync(cliLog), false, "The install gate started the bundled CLI.");
	await window.close();
	await delay(500);
	assert.ok(
		desktop.exitCode === null && desktop.signalCode === null,
		`Desktop exited when Connect Agent closed.\n${output.join("")}`,
	);
}

async function verifyDashboardBridge(context, window) {
	assert.equal(new URL(window.url()).origin, "https://cloud.clawdi.ai");
	const bridgeMethods = await window.evaluate(() => Object.keys(window.clawdiDesktop ?? {}).sort());
	assert.deepEqual(bridgeMethods, [
		"apiVersion",
		"createDashboardSession",
		"openConnectWizard",
		"openFilesWindow",
		"openRuntimeWindow",
		"openTerminalWindow",
		"retryDashboard",
		"signIn",
		"signOut",
	]);
	await window
		.getByRole("heading", { name: "Desktop sign-in expired" })
		.waitFor({ timeout: 20_000 });
	const initialTickets =
		readFileSync(cliLog, "utf8").match(/^auth desktop-session /gm)?.length ?? 0;
	await window.getByRole("button", { name: "Try again", exact: true }).click();
	const retryDeadline = Date.now() + 10_000;
	while (Date.now() < retryDeadline) {
		const tickets = readFileSync(cliLog, "utf8").match(/^auth desktop-session /gm)?.length ?? 0;
		if (tickets > initialTickets) break;
		await delay(100);
	}
	assert.ok(
		(readFileSync(cliLog, "utf8").match(/^auth desktop-session /gm)?.length ?? 0) > initialTickets,
		"Retry waited for the previous sign-in timeout instead of requesting a fresh ticket.",
	);
	const childOpened = context.waitForEvent("page", { timeout: 20_000 });
	await window.evaluate(
		(agentId) => window.clawdiDesktop.openTerminalWindow(`${location.origin}/terminal/${agentId}`),
		smokeAgentId,
	);
	const child = await childOpened;
	// The fake ticket cannot authenticate. Verify the stable route contract rather
	// than production copy: the child must withhold Terminal and preserve the
	// intended destination for the OAuth flow.
	await child.waitForURL((url) => url.pathname === "/sign-in", { timeout: 20_000 });
	const redirectUrl = new URL(child.url()).searchParams.get("redirect_url");
	assert.equal(redirectUrl, `/terminal/${smokeAgentId}`);
	assert.deepEqual(
		await child.evaluate(() => ({
			hasDesktopBridge: window.clawdiDesktop !== undefined,
			hasOpener: window.opener !== null,
		})),
		{ hasDesktopBridge: false, hasOpener: false },
	);
	await child.close();
	const cliCalls = readFileSync(cliLog, "utf8");
	assert.doesNotMatch(cliCalls, /^daemon install(?:\s|$)/m);
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

function diagnostics(output, cliLog) {
	let cliCalls = "<no CLI calls>";
	try {
		cliCalls = readFileSync(cliLog, "utf8").trim() || cliCalls;
	} catch {}
	return `Electron output:\n${output.join("")}\nCLI calls:\n${cliCalls}`;
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
