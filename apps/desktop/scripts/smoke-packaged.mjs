import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [executablePath, runtimeRoot] = process.argv.slice(2);
if (!executablePath || !runtimeRoot) {
	throw new Error("usage: smoke-packaged.mjs <executable> <runtime-root>");
}

const home = join(runtimeRoot, "home");
const clawdiHome = join(runtimeRoot, "state");
mkdirSync(home, { recursive: true });
mkdirSync(clawdiHome, { recursive: true });

const output = [];
const desktop = spawn(executablePath, ["--remote-debugging-port=0"], {
	env: { ...process.env, HOME: home, CLAWDI_HOME: clawdiHome },
	stdio: ["ignore", "pipe", "pipe"],
});
desktop.stdout.on("data", (chunk) => output.push(chunk.toString()));
desktop.stderr.on("data", (chunk) => output.push(chunk.toString()));

let browser;
try {
	const endpoint = await waitForDevToolsEndpoint(desktop, output, 30_000);
	browser = await chromium.connectOverCDP(endpoint);
	const context = browser.contexts()[0];
	if (!context) throw new Error("Packaged app did not create a browser context.");
	const window = await waitForConnectWindow(context, 30_000);
	const signIn = window.getByRole("heading", { name: "Sign in to Clawdi" });
	const failure = window.getByRole("heading", { name: "Couldn't finish setup" });
	await Promise.race([
		signIn.waitFor({ state: "visible", timeout: 20_000 }),
		failure.waitFor({ state: "visible", timeout: 20_000 }).then(async () => {
			throw new Error(`Packaged setup failed:\n${await window.locator("body").innerText()}`);
		}),
	]);
} finally {
	await browser?.close().catch(() => undefined);
	await stopProcess(desktop);
}

async function waitForConnectWindow(context, timeout) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const window = context.pages().find((page) => {
			try {
				const url = new URL(page.url());
				return url.protocol === "clawdi-app:" && url.pathname === "/renderer.html";
			} catch {
				return false;
			}
		});
		if (window) return window;
		await delay(100);
	}
	throw new Error(
		`Packaged app did not open Connect Agent. Pages: ${context
			.pages()
			.map((page) => page.url())
			.join(", ")}`,
	);
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
