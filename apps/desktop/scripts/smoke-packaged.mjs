import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const [executablePath, runtimeRoot, surface = "install"] = process.argv.slice(2);
if (!executablePath || !runtimeRoot || !["install", "welcome", "local"].includes(surface)) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root> [install|welcome|local]");
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
	if (surface === "local") {
		const window = await waitForWindow(context, 30_000);
		await window.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor({ timeout: 30_000 });
		await verifyLocalRenderer(context, window);
	} else if (surface === "welcome") {
		const window = await waitForWindow(context, 30_000);
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
	const window = await waitForWindow(context, 30_000);
	const moveToApplications = window.getByRole("heading", {
		name: "Move Clawdi to Applications",
	});
	const failure = window.getByRole("heading", { name: "Couldn't Finish Setup" });
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

async function verifyLocalRenderer(context, window) {
	assert.equal(new URL(window.url()).protocol, "clawdi-app:");
	await window.waitForFunction(() =>
		Array.from(document.images).some((image) => image.complete && image.naturalWidth > 0),
	);
	const local = await window.evaluate(() => {
		return {
			methods: Object.keys(window.clawdiConnect ?? {}).sort(),
			loadedLogo: Array.from(document.images).some(
				(image) => image.complete && image.naturalWidth > 0,
			),
			csp: document
				.querySelector('meta[http-equiv="Content-Security-Policy"]')
				?.getAttribute("content"),
		};
	});
	assert.equal(local.loadedLogo, true);
	assert.match(local.csp ?? "", /default-src 'none'/);
	assert.deepEqual(local.methods, [
		"addExcludedProject",
		"authenticate",
		"cancelAuthentication",
		"connectAgents",
		"detectAgents",
		"getBootstrapState",
		"getInstallationState",
		"listExcludedProjects",
		"listReconnectableAgents",
		"moveToApplicationsFolder",
		"onAuthenticationProgress",
		"onViewRequested",
		"openDashboard",
		"removeExcludedProject",
		"reopenVerificationPage",
		"takeRequestedView",
	]);
	await window.getByRole("button", { name: "Sign in", exact: true }).click();
	await window.getByRole("status").getByText("ABCD-EFGH", { exact: true }).waitFor();
	assert.match(await window.locator("body").innerText(), /Check that your browser shows this code/);
	assert.equal(await window.title(), "Continue in Your Browser");
	assert.match(readFileSync(cliLog, "utf8"), /^auth login --desktop$/m);
	await window.getByRole("button", { name: "Cancel", exact: true }).click();
	await window.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor();
	const originalUrl = window.url();
	await window.evaluate(() => {
		window.location.href = "https://cloud.clawdi.ai/";
	});
	await delay(500);
	assert.equal(window.url(), originalUrl, "The local wizard accepted remote dashboard navigation.");
	assert.ok(context.pages().every((page) => new URL(page.url()).protocol === "clawdi-app:"));
	assert.doesNotMatch(readFileSync(cliLog, "utf8"), /^daemon install(?:\s|$)/m);
}

async function waitForWindow(context, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const window = context.pages().find((page) => {
			try {
				const url = new URL(page.url());
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
