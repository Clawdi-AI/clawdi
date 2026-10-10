import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { _electron } from "@playwright/test";

declare global {
	interface Window {
		clawdiDesktop?: ClawdiDesktopBridge;
	}
}

const repo = resolve(import.meta.dir, "../../..");
const root = mkdtempSync(join(tmpdir(), "clawdi-shared-login-"));
const state = join(root, "home/.clawdi");
mkdirSync(state, { recursive: true });
mkdirSync(join(root, "electron"), { recursive: true });
writeFileSync(join(root, "electron", "first-connection"), "fixture");
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
	// Render the actual web /desktop-auth component with only Clerk replaced by a mock.
	const entry = join(root, "entry.tsx");
	writeFileSync(
		entry,
		`import React from '${repo}/apps/web/node_modules/react';
import {createRoot} from '${repo}/apps/web/node_modules/react-dom/client';
import {DesktopAuthPage} from '${repo}/apps/web/src/routes/desktop-auth';
createRoot(document.getElementById('root')).render(React.createElement(DesktopAuthPage));`,
	);
	const bundle = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: [
			{
				name: "mock-clerk",
				setup(build) {
					build.onResolve({ filter: /^@clerk\/tanstack-react-start$/ }, () => ({
						path: "clerk",
						namespace: "mock",
					}));
					build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
						loader: "js",
						contents: `
const signIn = {
 status: 'complete',
 async ticket({ticket}) {
   if(ticket !== 'mock-once' || document.cookie.includes('mock_used=')) return {error: {code:'ticket_invalid'}};
   document.cookie='mock_used=1; Secure; SameSite=Strict; Path=/';
   return {error:null};
 },
 async finalize() { document.cookie='mock_signed_in=user_fixture; Max-Age=3600; Secure; SameSite=Strict; Path=/'; document.cookie='__session=header.eyJzaWQiOiJzZXNzX2ZpeHR1cmUifQ.signature; Max-Age=3600; Secure; SameSite=Strict; Path=/'; return {error:null}; }
};
export function useAuth(){const signedIn=document.cookie.includes("mock_signed_in=user_fixture");return {isLoaded:true,isSignedIn:signedIn,userId:signedIn?"user_fixture":null,sessionId:signedIn?"sess_fixture":null};}
export function useSignIn(){return {signIn};}
export function useClerk(){return {async signOut(callback){ document.cookie="mock_signed_in=; Max-Age=0; Path=/"; document.cookie="__session=; Max-Age=0; Path=/"; callback?.(); } };}
`,
					}));
				},
			},
		],
	});
	assert.equal(bundle.success, true, "Could not bundle the Desktop auth fixture");
	const script = await bundle.outputs[0]?.text();
	assert.ok(script);
	async function launch() {
		const launched = await _electron.launch({
			args: [
				join(repo, "apps/desktop"),
				`--user-data-dir=${join(root, "electron")}`,
				// Linux test containers lack Chromium's OS sandbox support; production options are covered by dashboard-window.test.ts.
				...(process.platform === "linux" ? ["--no-sandbox"] : []),
				"--use-mock-keychain",
			],
			env: {
				...process.env,
				HOME: join(root, "home"),
				XDG_CONFIG_HOME: join(root, "config"),
				CLAWDI_HOME: state,
				CLAWDI_DESKTOP_CLI: join(repo, "apps/desktop/scripts/shared-login-native.sh"),
				CLAWDI_DESKTOP_SMOKE_TARGET: `${process.platform}-${process.arch}`,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
			},
		});
		const context = launched.context();
		context.setDefaultTimeout(15_000);
		await launched.evaluate(({ app, shell }) => {
			const testApp = app as typeof app & { openedUrls: string[] };
			testApp.openedUrls = [];
			shell.openExternal = async (url) => {
				testApp.openedUrls.push(url);
			};
		});
		await context.route("https://cloud.clawdi.ai/**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/mock-auth.js") {
				await route.fulfill({ status: 200, contentType: "application/javascript", body: script });
				return;
			}
			let html = "<!doctype html><div id='root'></div>";
			if (url.pathname === "/desktop-auth")
				html += `<script type="module" src="/mock-auth.js"></script>`;
			else if (route.request().headers().cookie?.includes("mock_signed_in=user_fixture"))
				html += `<h1>Signed in as user_fixture</h1><button onclick='window.clawdiDesktop.signOut()'>Sign out</button>`;
			else html += "<h1>Signed out</h1>";
			await route.fulfill({ status: 200, contentType: "text/html", body: html });
		});
		return launched;
	}
	application = await launch();
	let context = application.context();
	const connect = await application.firstWindow();
	await connect.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor();
	console.info("First launch verified; checking browser ticket refusal.");
	const browserWindowPromise = application.waitForEvent("window");
	await application.evaluate(async ({ BrowserWindow }) => {
		const browser = new BrowserWindow({
			show: false,
			webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
		});
		await browser.loadURL("https://cloud.clawdi.ai/desktop-auth#ticket=browser-ticket");
	});
	const normalBrowser = await browserWindowPromise;
	await normalBrowser.getByRole("heading", { name: "Open this page in Clawdi Desktop" }).waitFor();
	assert.equal(await normalBrowser.evaluate(() => typeof window.clawdiDesktop), "undefined");
	assert.equal(
		await normalBrowser.evaluate(() => document.cookie.includes("mock_signed_in=")),
		false,
	);
	await normalBrowser.close();
	console.info("Browser ticket refusal verified; approving mock device sign-in.");

	assert.equal(await connect.evaluate(() => typeof window.clawdiDesktop), "undefined");
	await connect.getByRole("button", { name: "Sign in", exact: true }).click();
	await connect.getByRole("status").getByText("ABCD-EFGH", { exact: true }).waitFor();
	writeFileSync(join(state, "approved"), "");
	await connect.getByRole("button", { name: /Connect/ }).click();
	await connect.getByRole("heading", { name: "Agents Connected" }).waitFor();
	await connect.getByRole("button", { name: "Open dashboard", exact: false }).click();
	let dashboard = await waitForDashboard();
	await dashboard.getByRole("heading", { name: "Signed in as user_fixture" }).waitFor();
	assert.equal(readFileSync(join(state, "ticket-count"), "utf8"), "ticket\n");
	// Persisted cookies must survive a complete Electron shutdown, not just closing the window.
	await application.evaluate(async ({ session }) => {
		await session.fromPartition("persist:clawdi-dashboard").cookies.flushStore();
	});
	await application.close();
	application = await launch();
	context = application.context();
	dashboard = await waitForDashboard();
	await dashboard.getByRole("heading", { name: "Signed in as user_fixture" }).waitFor();
	assert.equal(
		readFileSync(join(state, "ticket-count"), "utf8"),
		"ticket\n",
		"Restart must not mint a second ticket",
	);
	// Signed-out SPA routes return to the handshake rather than blocked OAuth redirects.
	await dashboard.evaluate(() => {
		history.pushState(null, "", "/sign-in");
	});
	await dashboard.waitForURL("https://cloud.clawdi.ai/");
	await dashboard.getByRole("heading", { name: "Signed in as user_fixture" }).waitFor();
	console.info("Embedded dashboard signed in; checking IPC and sign-out.");
	await application.evaluate(({ app }) => {
		(app as typeof app & { openedUrls: string[] }).openedUrls = [];
	});
	const reconnectWindow = application.waitForEvent("window");
	await dashboard.evaluate(() => window.clawdiDesktop?.openConnector());
	const connected = await reconnectWindow;
	await connected.getByRole("heading", { name: "Choose Agents" }).waitFor();
	await dashboard.close();
	await connected.getByRole("button", { name: "Open dashboard", exact: false }).click();
	dashboard = await waitForDashboard();
	await dashboard.getByRole("heading", { name: "Signed in as user_fixture" }).waitFor();
	assert.equal(readFileSync(join(state, "login-count"), "utf8"), "approval\n");
	assert.equal(dashboard.url(), "https://cloud.clawdi.ai/");
	assert.equal(existsSync(join(state, "auth.json")), true);
	assert.equal(await dashboard.evaluate(() => typeof process), "undefined");
	assert.deepEqual(await dashboard.evaluate(() => Object.keys(window.clawdiDesktop ?? {}).sort()), [
		"createDashboardSession",
		"openConnector",
		"signOut",
		"version",
	]);
	assert.equal(await dashboard.evaluate(() => Object.isFrozen(window.clawdiDesktop)), true);
	await assert.rejects(
		dashboard.evaluate(() => window.clawdiDesktop?.createDashboardSession(null)),
	);
	const original = dashboard.url();
	await dashboard.evaluate(() => {
		window.location.href = "https://evil.test/";
	});
	await dashboard.waitForTimeout(300);
	assert.equal(dashboard.url(), original);
	// Electron cancels navigation; reset Playwright's navigation signal before locator actions.
	await dashboard.goto(original, { waitUntil: "domcontentloaded" });
	await dashboard.evaluate(() => {
		window.open("https://docs.clawdi.ai/start");
		window.open("file:///etc/passwd");
	});
	await dashboard.waitForTimeout(100);
	assert.deepEqual(
		await application.evaluate(
			({ app }) => (app as typeof app & { openedUrls: string[] }).openedUrls,
		),
		["https://docs.clawdi.ai/start"],
	);
	assert.equal(await dashboard.evaluate(() => Notification.requestPermission()), "denied");
	await dashboard.bringToFront();
	await dashboard.evaluate(() => navigator.clipboard.writeText("clawdi clipboard fixture"));
	await context.route("https://bank.test/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<h1>3DS fixture</h1>" }),
	);

	await dashboard.evaluate(() => {
		const iframe = document.createElement("iframe");
		iframe.name = "dashboard-child";
		iframe.src = "/";
		document.body.append(iframe);
	});
	await dashboard.locator("iframe").waitFor();
	const child = dashboard.frame("dashboard-child");
	assert.ok(child);
	await child.waitForLoadState();
	assert.equal(await child.evaluate(() => typeof window.clawdiDesktop), "undefined");
	await dashboard.evaluate(() => {
		const iframe = document.createElement("iframe");
		iframe.name = "stripe-3ds";
		iframe.src = "https://bank.test/challenge";
		document.body.append(iframe);
	});
	await dashboard
		.frameLocator('iframe[name="stripe-3ds"]')
		.getByRole("heading", { name: "3DS fixture" })
		.waitFor();
	writeFileSync(join(state, "fail-revoke"), "");
	await assert.rejects(dashboard.evaluate(() => window.clawdiDesktop?.signOut()));
	assert.equal(existsSync(join(state, "auth.json")), true);
	assert.equal(await dashboard.evaluate(() => document.cookie.includes("__session=")), true);
	rmSync(join(state, "fail-revoke"));
	const nextWindow = application.waitForEvent("window");
	await dashboard.getByRole("button", { name: "Sign out", exact: true }).click();
	const welcome = await nextWindow;
	await welcome.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor();
	assert.equal(existsSync(join(state, "auth.json")), false);
	assert.equal(existsSync(join(state, "sync")), false);
	const cookies = await application.evaluate(async ({ session }) =>
		session.fromPartition("persist:clawdi-dashboard").cookies.get({}),
	);
	assert.deepEqual(cookies, []);
	assert.equal(readFileSync(join(state, "revoked"), "utf8"), "revoked\n");
	const logs = await application.evaluate(({ app }) => app.getPath("logs"));
	if (existsSync(join(logs, "main.log")))
		assert.doesNotMatch(readFileSync(join(logs, "main.log"), "utf8"), /mock-once|mock-only/);
	console.info(
		"Verified real Electron: device sign-in → Connect → embedded signed-in dashboard → persisted restart (one ticket) → openConnector → server revoke and shared sign-out; security and IPC gates passed.",
	);

	async function waitForDashboard() {
		for (let i = 0; i < 100; i++) {
			const page = context
				.pages()
				.find((page) => page.url().startsWith("https://cloud.clawdi.ai/"));
			if (page) return page;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Dashboard did not open");
	}
} finally {
	await application?.close();
	rmSync(root, { recursive: true, force: true });
}
