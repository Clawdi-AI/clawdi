import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ClawdiDesktopConnectBridge } from "@clawdi/shared/desktop";
import { type Browser, chromium } from "@playwright/test";
import { nativeLauncherPath } from "../src/cli-compat";
import { runCommand } from "../src/command-runner";

declare global {
	interface Window {
		clawdiConnect?: ClawdiDesktopConnectBridge;
	}
}

const desktop = resolve(import.meta.dir, "..");
// Resolve directory symlinks before setting fixture homes. Windows may still
// retain 8.3 aliases; bundled executable comparisons use file identity below.
const root = realpathSync(mkdtempSync(join(tmpdir(), "clawdi-shared-native-")));
const extension = process.platform === "win32" ? ".exe" : "";
const bundledResource = join(desktop, "resources", "native", `clawdi${extension}`);
const hadNativeDirectory = existsSync(dirname(bundledResource));
const hadBundledResource = existsSync(bundledResource);
let application: ChildProcess | undefined;
let browser: Browser | undefined;

async function stopDesktop(): Promise<void> {
	await browser
		?.close()
		.catch((error) => console.error("Could not close the fixture CDP connection", error));
	browser = undefined;
	const child = application;
	application = undefined;
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	const exited = once(child, "exit");
	if (process.platform === "win32") {
		// Match smoke-packaged.mjs: Electron closes its Chromium children on
		// shutdown. taskkill /T can race processes already closed by CDP.
		child.kill("SIGTERM");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const graceful = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((done) => {
					timer = setTimeout(() => done(false), 5_000);
				}),
			]);
			if (!graceful) child.kill("SIGKILL");
		} finally {
			if (timer) clearTimeout(timer);
		}
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
		}
	}
	await exited;
}

async function connectToDesktop(child: ChildProcess): Promise<Browser> {
	// Packaged apps disable Node inspection via Electron fuses. Attach to
	// Chromium CDP, as smoke-packaged.mjs does, keeping those fuses intact.
	const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
		let output = "";
		const timer = setTimeout(
			() => finish(new Error("Packaged Desktop did not expose CDP.")),
			30_000,
		);
		const exited = () => finish(new Error("Packaged Desktop exited before CDP was ready."));
		const consume = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-64_000);
			const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
			if (match?.[1]) finish(undefined, match[1]);
		};
		function finish(error?: Error, url?: string): void {
			clearTimeout(timer);
			child.off("exit", exited);
			child.off("error", finish);
			child.stdout?.off("data", consume);
			child.stderr?.off("data", consume);
			if (error) reject(error);
			else if (url) resolveEndpoint(url);
		}
		child.once("exit", exited);
		child.once("error", finish);
		child.stdout?.on("data", consume);
		child.stderr?.on("data", consume);
	});
	child.stdout?.resume();
	child.stderr?.resume();
	return chromium.connectOverCDP(endpoint);
}

function calls(directory: string): Array<Record<string, unknown>> {
	return readFileSync(join(directory, "calls.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const value: unknown = JSON.parse(line);
			assert.ok(value && typeof value === "object" && !Array.isArray(value));
			return Object.fromEntries(Object.entries(value));
		});
}

try {
	for (const version of ["0.16.8", "0.16.9"]) {
		const result = await Bun.build({
			entrypoints: [join(import.meta.dir, "fixtures/shared-native-cli.ts")],
			compile: { outfile: join(root, `fixture-${version}${extension}`) },
			define: { CLI_FIXTURE_VERSION: JSON.stringify(version) },
		});
		assert.equal(result.success, true, `Could not compile fake CLI ${version}`);
	}
	if (hadBundledResource) cpSync(bundledResource, join(root, "original-cli"));
	mkdirSync(dirname(bundledResource), { recursive: true });
	cpSync(join(root, `fixture-0.16.8${extension}`), bundledResource);
	await runCommand(
		"node",
		[
			join(desktop, "node_modules/electron-builder/cli.js"),
			"--projectDir",
			desktop,
			process.platform === "win32" ? "--win" : "--linux",
			"--dir",
			`--${process.arch}`,
			"--publish",
			"never",
			`--config.directories.output=${join(root, "packaged")}`,
			`--config.afterPack=${join(desktop, "scripts/after-pack.mjs")}`,
		],
		{
			timeoutMs: 180_000,
			env: {
				...process.env,
				ELECTRON_BUILDER_CACHE: join(root, "builder-cache"),
				ELECTRON_CACHE: join(root, "electron-cache"),
			},
		},
	);
	const packageDirectory = join(
		root,
		"packaged",
		process.platform === "win32" ? "win-unpacked" : "linux-unpacked",
	);
	const packagedCli = join(packageDirectory, "resources", "native", `clawdi${extension}`);
	for (const scenario of ["fresh", "newer", "migration", "offline"]) {
		const directory = join(root, scenario);
		const home = join(directory, "home");
		const userData = join(directory, "electron");
		mkdirSync(userData, { recursive: true });
		mkdirSync(home);
		writeFileSync(join(userData, "first-connection"), "fixture");
		for (const version of ["0.16.8", "0.16.9"])
			cpSync(
				join(root, `fixture-${version}${extension}`),
				join(directory, `fixture-${version}${extension}`),
			);
		const bundled = packagedCli;
		const launcher = nativeLauncherPath(process.platform, home);
		const env = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			LOCALAPPDATA: join(directory, "local"),
			XDG_CONFIG_HOME: join(directory, "config"),
			CLAWDI_HOME: join(home, ".clawdi"),
			CLAWDI_NATIVE_E2E_ROOT: directory,
			CLAWDI_DESKTOP_CLI: bundled,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_DESKTOP_RUNTIME: "/old/desktop/runtime",
		};
		if (scenario === "newer") {
			await runCommand(
				join(directory, `fixture-0.16.9${extension}`),
				["update", "--native-bootstrap"],
				{ env },
			);
			rmSync(join(directory, "calls.jsonl"));
		} else if (scenario === "migration") {
			if (process.platform !== "win32") {
				mkdirSync(dirname(launcher), { recursive: true });
				symlinkSync(bundled, launcher);
			} else {
				const shim = join(env.LOCALAPPDATA, "Clawdi/bin/clawdi.cmd");
				mkdirSync(dirname(shim), { recursive: true });
				writeFileSync(
					shim,
					`@rem Clawdi Desktop CLI launcher v1\r\n@echo off\r\n"${bundled}" %*\r\n`,
				);
			}
			writeFileSync(join(directory, "signed-in"), "fixture");
			writeFileSync(
				join(directory, "unit.json"),
				JSON.stringify({
					command: bundled,
					executable: bundled,
					version: "0.16.7",
					noAutoUpdate: "1",
				}),
			);
		} else if (scenario === "offline") {
			writeFileSync(join(directory, "offline"), "fixture");
		}
		application = spawn(
			join(packageDirectory, process.platform === "win32" ? "Clawdi.exe" : "clawdi-desktop"),
			[
				`--user-data-dir=${userData}`,
				"--remote-debugging-port=0",
				...(process.platform === "linux" ? ["--no-sandbox"] : []),
				"--use-mock-keychain",
			],
			{ env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
		);
		browser = await connectToDesktop(application);
		const context = browser.contexts()[0];
		assert.ok(context);
		const page = context.pages()[0] ?? (await context.waitForEvent("page"));
		page.setDefaultTimeout(30_000);
		if (scenario === "migration") {
			await page.getByRole("heading", { name: "Choose Agents" }).waitFor();
			for (
				let attempt = 0;
				attempt < 100 &&
				!calls(directory).some(
					(call) => Array.isArray(call.args) && call.args.join(" ") === "daemon install",
				);
				attempt++
			)
				await new Promise((done) => setTimeout(done, 100));
		} else {
			await page.getByRole("heading", { name: "Welcome to Clawdi" }).waitFor();
			await page.getByRole("button", { name: "Sign in", exact: true }).click();
			await page.getByRole("button", { name: /Connect/ }).click();
			await page.getByRole("heading", { name: "Agents Connected" }).waitFor();
		}
		const installed: unknown = JSON.parse(readFileSync(join(directory, "unit.json"), "utf8"));
		assert.ok(installed && typeof installed === "object" && "command" in installed);
		const unit = Object.fromEntries(Object.entries(installed));
		const invocations = calls(directory);
		if (scenario === "offline") {
			assert.ok(typeof unit.command === "string");
			// The executable can report Windows' long path while Bun's temp
			// directory retains an 8.3 alias. Both must identify the same file.
			const actualFile = statSync(unit.command, { bigint: true });
			const bundledFile = statSync(bundled, { bigint: true });
			assert.equal(actualFile.dev, bundledFile.dev);
			assert.equal(actualFile.ino, bundledFile.ino);
			assert.equal(unit.noAutoUpdate, "1");
			assert.ok(invocations.every((call) => call.native === false));
		} else {
			assert.equal(unit.command, launcher);
			assert.equal(unit.noAutoUpdate, undefined);
			assert.match(realpathSync(launcher), /versions[/\\]0\.16\.(8|9)-/);
			assert.ok(
				invocations
					.filter((call) => call.native)
					.every((call) => call.noAutoUpdate === undefined && call.desktopRuntime === undefined),
			);
			if (scenario === "newer") {
				assert.equal(unit.version, "0.16.9");
				assert.ok(
					invocations.every((call) => call.native === true),
					"Bundled N must never replace native N+1",
				);
			}
			if (scenario === "migration" && process.platform === "win32")
				assert.ok(
					readFileSync(join(env.LOCALAPPDATA, "Clawdi/bin/clawdi.cmd"), "utf8").includes(
						`"${launcher}" %*`,
					),
				);
			if (scenario === "fresh") {
				await runCommand(launcher, ["update", "--fixture-auto-update"], { env });
				const state = await page.evaluate(() => window.clawdiConnect?.getBootstrapState());
				assert.equal(state?.cli.version, "0.16.9");
				assert.equal(state?.daemon.running, true);
				assert.equal(
					calls(directory).filter(
						(call) => Array.isArray(call.args) && call.args.join(" ") === "daemon install",
					).length,
					1,
				);
				writeFileSync(join(directory, "future-schema"), "fixture");
				await assert.rejects(
					page.evaluate(() => window.clawdiConnect?.detectAgents()),
					/Update Clawdi Desktop/,
				);
				await page.reload();
				await page.getByRole("heading", { name: "Update Clawdi Desktop" }).waitFor();
			}
		}
		await stopDesktop();
		console.info(`Real Electron shared native CLI: ${scenario} passed`);
	}
} catch (error) {
	console.error("Shared native CLI e2e failed", error);
	throw error;
} finally {
	await stopDesktop();
	if (process.platform === "win32") {
		const shim = join(root, "offline", "local", "Clawdi", "bin", "clawdi.cmd");
		if (existsSync(shim)) {
			await runCommand("powershell.exe", [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(desktop, "build/windows-cli-path.ps1"),
				"-Action",
				"Remove",
				"-BinPath",
				dirname(shim),
				"-LauncherPath",
				shim,
			]);
		}
	}
	if (hadBundledResource && existsSync(join(root, "original-cli")))
		cpSync(join(root, "original-cli"), bundledResource);
	else if (!hadBundledResource) rmSync(bundledResource, { force: true });
	if (!hadNativeDirectory) rmSync(dirname(bundledResource), { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
}
