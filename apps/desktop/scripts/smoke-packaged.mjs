import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [executablePath, runtimeRoot, surface = "install"] = process.argv.slice(2);
const smokeAgentId = "00000000-0000-4000-8000-000000000001";
if (!executablePath || !runtimeRoot || !["install", "dashboard"].includes(surface)) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root> [install|dashboard]");
}

const home = join(runtimeRoot, "home");
const clawdiHome = join(runtimeRoot, "state");
const cliLog = join(runtimeRoot, "native-cli.log");
mkdirSync(home, { recursive: true });
mkdirSync(clawdiHome, { recursive: true });

const output = [];
const desktop = spawn(
	executablePath,
	[`--user-data-dir=${join(runtimeRoot, "electron-data")}`, "--remote-debugging-port=0"],
	{
		env: {
			...process.env,
			HOME: home,
			CLAWDI_HOME: clawdiHome,
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
	if (surface === "dashboard") await verifyPackagedDashboard(context);
	else await verifyInstallGate(context, desktop, output, cliLog);
} catch (error) {
	failure = error;
} finally {
	await browser?.close().catch(() => undefined);
	await stopProcess(desktop);
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

async function verifyPackagedDashboard(context) {
	const window = await waitForWindow(context, "dashboard", 30_000);
	await window.waitForFunction(() => globalThis.Clerk?.loaded === true, null, { timeout: 20_000 });
	await Promise.race([
		window.getByRole("heading", { name: "Signing in to Clawdi" }).waitFor({ timeout: 20_000 }),
		window.getByRole("heading", { name: "Desktop sign-in expired" }).waitFor({ timeout: 20_000 }),
	]);
	assert.equal(new URL(window.url()).origin, "https://cloud.clawdi.ai");
	const documentSecurity = await window.evaluate(async () => {
		const [index, missing] = await Promise.all([
			fetch("/index.html", { method: "HEAD", cache: "no-store" }),
			fetch("/assets/not-packaged.js", { cache: "no-store" }),
		]);
		const resourceUrls = performance
			.getEntriesByType("resource")
			.map((entry) => new URL(entry.name));
		const localAssetStatuses = await Promise.all(
			[...new Set(resourceUrls)]
				.filter((url) => url.origin === location.origin && url.pathname.startsWith("/assets/"))
				.map(async (url) => ({
					url: url.href,
					status: (await fetch(url, { method: "HEAD" })).status,
				})),
		);
		return {
			csp: index.headers.get("content-security-policy"),
			missingStatus: missing.status,
			inlineScriptsHaveNonces: [...document.scripts]
				.filter((script) => !script.src)
				.every((script) => script.nonce.length > 0),
			scriptUrls: [...document.scripts]
				.filter((script) => script.src)
				.map((script) => new URL(script.src)),
			resourceUrls,
			localAssetStatuses,
			clerkLoaded: globalThis.Clerk?.loaded === true,
		};
	});
	assert.match(documentSecurity.csp ?? "", /script-src[^;]*'nonce-[^']+'/);
	assert.doesNotMatch(documentSecurity.csp ?? "", /script-src[^;]*https:/);
	assert.equal(documentSecurity.inlineScriptsHaveNonces, true);
	assert.equal(documentSecurity.missingStatus, 404);
	assert.equal(documentSecurity.clerkLoaded, true);
	assert.deepEqual(
		documentSecurity.localAssetStatuses.filter((asset) => asset.status !== 200),
		[],
		"The packaged Dashboard requested a local asset that was not bundled.",
	);
	assert.deepEqual(
		[...new Set(documentSecurity.scriptUrls.map((url) => url.origin))],
		["https://cloud.clawdi.ai"],
	);
	assert.ok(
		documentSecurity.resourceUrls.some((url) => url.pathname === "/assets/clerk.browser.js"),
		"The packaged Dashboard did not load its bundled Clerk runtime.",
	);
	const bridgeMethods = await window.evaluate(() => Object.keys(window.clawdiDesktop ?? {}).sort());
	assert.deepEqual(bridgeMethods, [
		"openConnectWizard",
		"openFilesWindow",
		"openRuntimeWindow",
		"openTerminalWindow",
		"retryDashboard",
		"signIn",
		"signOut",
	]);
	const childOpened = context.waitForEvent("page", { timeout: 20_000 });
	await window.evaluate(
		(agentId) => window.clawdiDesktop.openTerminalWindow(`${location.origin}/terminal/${agentId}`),
		smokeAgentId,
	);
	const child = await childOpened;
	await child.waitForLoadState("domcontentloaded");
	assert.equal(new URL(child.url()).pathname, `/terminal/${smokeAgentId}`);
	await child.locator('main[data-mava-launcher="hidden"]').waitFor({
		state: "visible",
		timeout: 20_000,
	});
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
